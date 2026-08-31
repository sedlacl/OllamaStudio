import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkSafetensorsFile,
  enrichTabbyModelSummaries,
  expectedSafetensorsFileSize,
  inspectLocalModel,
  invalidateLocalModelCache,
  resetLocalModelCacheForTests
} from './local-model-info'

const dirs: string[] = []

afterEach(async () => {
  resetLocalModelCacheForTests()
  while (dirs.length) {
    const dir = dirs.pop() as string
    await rm(dir, { recursive: true, force: true })
  }
})

function tempModelDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'os-local-model-'))
  dirs.push(dir)
  return dir
}

function writeMinimalSafetensors(
  filePath: string,
  payloadBytes: number,
  truncateTo?: number
): void {
  const header = JSON.stringify({
    __metadata__: { format: 'pt' },
    weight: { dtype: 'F32', shape: [payloadBytes / 4], data_offsets: [0, payloadBytes] }
  })
  const headerBuf = Buffer.from(header, 'utf8')
  const lenBuf = Buffer.alloc(8)
  lenBuf.writeBigUInt64LE(BigInt(headerBuf.length), 0)
  const payload = Buffer.alloc(payloadBytes, 0xab)
  let full = Buffer.concat([lenBuf, headerBuf, payload])
  if (truncateTo != null && truncateTo < full.length) {
    full = full.subarray(0, truncateTo)
  }
  writeFileSync(filePath, full)
}

describe('expectedSafetensorsFileSize', () => {
  it('computes 8 + header + max tensor offset', () => {
    const headerSize = 42
    const header = {
      weight: { data_offsets: [0, 1000] },
      other: { data_offsets: [1000, 2500] }
    }
    expect(expectedSafetensorsFileSize(headerSize, header)).toBe(8 + headerSize + 2500)
  })
})

describe('inspectLocalModel', () => {
  it('sums bytes for a complete sharded folder', async () => {
    const modelDir = tempModelDir()
    const folder = join(modelDir, 'complete-model')
    mkdirSync(folder)
    writeFileSync(join(folder, 'config.json'), '{}')
    writeMinimalSafetensors(join(folder, 'model-00001-of-00002.safetensors'), 64)
    writeMinimalSafetensors(join(folder, 'model-00002-of-00002.safetensors'), 32)
    writeFileSync(
      join(folder, 'model.safetensors.index.json'),
      JSON.stringify({ weight_map: { w1: 'model-00001-of-00002.safetensors', w2: 'model-00002-of-00002.safetensors' } })
    )

    const info = await inspectLocalModel(modelDir, 'complete-model')
    expect(info.sizeState).toBe('known')
    expect(info.completeness).toBe('complete')
    expect(info.sizeBytes).toBeGreaterThan(100)
  })

  it('marks truncated safetensors as incomplete', async () => {
    const modelDir = tempModelDir()
    const folder = join(modelDir, 'truncated')
    mkdirSync(folder)
    writeFileSync(join(folder, 'config.json'), '{}')
    const file = join(folder, 'model.safetensors')
    writeMinimalSafetensors(file, 512)
    const full = readFileSync(file)
    writeFileSync(file, full.subarray(0, full.length - 100))

    const info = await inspectLocalModel(modelDir, 'truncated')
    expect(info.completeness).toBe('incomplete')
    expect(info.sizeBytes).toBeLessThan(full.length)
    expect(info.sizeBytes).toBeGreaterThan(0)
  })

  it('marks .part files as incomplete', async () => {
    const modelDir = tempModelDir()
    const folder = join(modelDir, 'partial')
    mkdirSync(folder)
    writeFileSync(join(folder, 'config.json'), '{}')
    writeFileSync(join(folder, 'model.safetensors.part'), 'partial')

    const info = await inspectLocalModel(modelDir, 'partial')
    expect(info.completeness).toBe('incomplete')
  })

  it('returns 0 B for an empty valid folder without config as incomplete', async () => {
    const modelDir = tempModelDir()
    const folder = join(modelDir, 'empty')
    mkdirSync(folder)

    const info = await inspectLocalModel(modelDir, 'empty')
    expect(info.sizeBytes).toBe(0)
    expect(info.completeness).toBe('incomplete')
  })

  it('marks missing config as incomplete', async () => {
    const modelDir = tempModelDir()
    const folder = join(modelDir, 'no-config')
    mkdirSync(folder)
    writeMinimalSafetensors(join(folder, 'model.safetensors'), 64)

    const info = await inspectLocalModel(modelDir, 'no-config')
    expect(info.completeness).toBe('incomplete')
  })

  it('refuses path traversal', async () => {
    const modelDir = tempModelDir()
    const outside = tempModelDir()
    writeFileSync(join(outside, 'secret.bin'), 'x'.repeat(100))

    const info = await inspectLocalModel(modelDir, '../' + outside.split(/[/\\]/).pop()!)
    expect(info.sizeState).toBe('unknown')
    expect(info.sizeBytes).toBeNull()
  })

  it('does not follow symlink escape outside modelDir', async () => {
    const modelDir = tempModelDir()
    const outside = tempModelDir()
    writeFileSync(join(outside, 'secret.bin'), 'x'.repeat(200))
    const folder = join(modelDir, 'linked')
    mkdirSync(folder)
    writeFileSync(join(folder, 'config.json'), '{}')
    if (process.platform === 'win32') {
      try {
        await symlink(join(outside, 'secret.bin'), join(folder, 'escape.bin'), 'file')
      } catch {
        return
      }
    } else {
      await symlink(join(outside, 'secret.bin'), join(folder, 'escape.bin'))
    }

    const info = await inspectLocalModel(modelDir, 'linked')
    expect(info.completeness).toBe('incomplete')
    expect(info.sizeBytes).toBeLessThan(200)
  })

  it('uses cache within TTL without rescanning', async () => {
    const modelDir = tempModelDir()
    const folder = join(modelDir, 'cached')
    mkdirSync(folder)
    writeFileSync(join(folder, 'config.json'), '{}')
    writeMinimalSafetensors(join(folder, 'model.safetensors'), 64)

    const first = await inspectLocalModel(modelDir, 'cached')
    const second = await inspectLocalModel(modelDir, 'cached')
    expect(second).toEqual(first)

    invalidateLocalModelCache('cached')
    writeFileSync(join(folder, 'extra.txt'), 'more')
    const third = await inspectLocalModel(modelDir, 'cached')
    expect(third.sizeBytes).toBeGreaterThan(first.sizeBytes!)
  })
})

describe('checkSafetensorsFile', () => {
  it('detects truncated files', async () => {
    const modelDir = tempModelDir()
    const file = join(modelDir, 't.safetensors')
    writeMinimalSafetensors(file, 128)
    const full = readFileSync(file)
    writeFileSync(file, full.subarray(0, full.length - 20))
    expect(await checkSafetensorsFile(file, full.length - 20)).toBe('truncated')
  })
})

describe('enrichTabbyModelSummaries', () => {
  it('never maps missing API size to zero', async () => {
    const modelDir = tempModelDir()
    const folder = join(modelDir, 'api-model')
    mkdirSync(folder)
    writeFileSync(join(folder, 'config.json'), '{}')
    writeMinimalSafetensors(join(folder, 'model.safetensors'), 48)

    const enriched = await enrichTabbyModelSummaries(
      [{ modelId: 'api-model', displayName: 'api-model', backend: 'tabby' }],
      modelDir
    )
    expect(enriched[0].sizeBytes).not.toBe(0)
    expect(enriched[0].sizeBytes).toBeGreaterThan(50)
    expect(enriched[0].localCompleteness).toBe('complete')
  })

  it('uses active download session bytes for running folder', async () => {
    const modelDir = tempModelDir()
    const enriched = await enrichTabbyModelSummaries(
      [{ modelId: 'dl-folder', displayName: 'dl-folder', backend: 'tabby' }],
      modelDir,
      {
        sequence: 1,
        form: { repoId: '', revision: '', folderName: '' },
        session: {
          sequence: 1,
          operationId: 'op',
          repoId: 'org/model',
          revision: 'main',
          folderName: 'dl-folder',
          status: 'running',
          downloadedBytes: 12345,
          totalBytes: 99999,
          percent: 12,
          dismissed: false,
          startedAt: Date.now(),
          updatedAt: Date.now()
        }
      }
    )
    expect(enriched[0].sizeBytes).toBe(12345)
    expect(enriched[0].localCompleteness).toBe('incomplete')
  })

  it('enriches every listed model', async () => {
    const modelDir = tempModelDir()
    for (let i = 0; i < 8; i++) {
      const folder = join(modelDir, `m-${i}`)
      mkdirSync(folder)
      writeFileSync(join(folder, 'config.json'), '{}')
      writeMinimalSafetensors(join(folder, 'model.safetensors'), 16)
    }
    const models = Array.from({ length: 8 }, (_, i) => ({
      modelId: `m-${i}`,
      displayName: `m-${i}`,
      backend: 'tabby' as const
    }))
    const enriched = await enrichTabbyModelSummaries(models, modelDir)
    expect(enriched).toHaveLength(8)
    for (const row of enriched) {
      expect(row.sizeBytes).toBeGreaterThan(0)
      expect(row.localCompleteness).toBe('complete')
    }
  })
})

describe('real disk siblings (optional integration)', () => {
  it('classifies known Tabby runtime folders when present', async () => {
    const modelDir = 'D:\\AI\\Tabby\\models'
    try {
      readFileSync(join(modelDir, 'Qwen3.8-27B-exl3-SC_3.00bpw_H4-2-2', 'config.json'))
    } catch {
      return
    }
    resetLocalModelCacheForTests()
    const complete = await inspectLocalModel(modelDir, 'Qwen3.8-27B-exl3-SC_3.00bpw_H4-2-2')
    const partial = await inspectLocalModel(modelDir, 'Qwen3.8-27B-exl3-SC_3.00bpw_H4')
    expect(complete.completeness).toBe('complete')
    expect(complete.sizeBytes).toBeGreaterThan(10e9)
    expect(partial.completeness).toBe('incomplete')
    expect(partial.sizeBytes).toBeGreaterThan(1e9)
    expect(partial.sizeBytes).toBeLessThan(complete.sizeBytes!)
  })
})
