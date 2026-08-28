import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteTabbyDownloadFolder, hfErrorToMessage, runTabbyHfDownload } from './hf-download'
import { resetDownloadSessionForTests } from './download-session'
import { setTabbyPatchReadiness } from './patch-readiness'

const dirs: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  resetDownloadSessionForTests()
  setTabbyPatchReadiness({ externalProcess: false, runtimePatchValid: true })
  while (dirs.length) {
    const dir = dirs.pop() as string
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempModelDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'os-hf-folder-'))
  dirs.push(dir)
  return dir
}

describe('deleteTabbyDownloadFolder', () => {
  it('deletes a leftover model folder inside modelDir', async () => {
    const modelDir = await tempModelDir()
    const folder = join(modelDir, 'Qwen-partial')
    mkdirSync(folder)
    writeFileSync(join(folder, 'weights.safetensors'), 'abc')

    const result = await deleteTabbyDownloadFolder(modelDir, 'Qwen-partial')
    expect(result).toEqual({ ok: true })
    await expect(readFile(join(folder, 'weights.safetensors'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('is a no-op when the folder is already gone', async () => {
    const modelDir = await tempModelDir()
    await expect(deleteTabbyDownloadFolder(modelDir, 'missing')).resolves.toEqual({ ok: true })
  })

  it('refuses path traversal and never deletes modelDir itself', async () => {
    const modelDir = await tempModelDir()
    await writeFile(join(modelDir, 'keep.txt'), 'safe')

    const outside = mkdtempSync(join(tmpdir(), 'os-hf-outside-'))
    dirs.push(outside)
    await writeFile(join(outside, 'secret.txt'), 'nope')

    await expect(deleteTabbyDownloadFolder(modelDir, '..')).resolves.toMatchObject({ ok: false })
    await expect(deleteTabbyDownloadFolder(modelDir, '../secret')).resolves.toMatchObject({
      ok: false
    })
    await expect(deleteTabbyDownloadFolder(modelDir, '..\\secret')).resolves.toMatchObject({
      ok: false
    })
    await expect(deleteTabbyDownloadFolder(modelDir, '')).resolves.toMatchObject({ ok: false })
    await expect(deleteTabbyDownloadFolder(modelDir, '.')).resolves.toMatchObject({ ok: false })
    await expect(deleteTabbyDownloadFolder(modelDir, resolve(modelDir))).resolves.toMatchObject({
      ok: false
    })
    await expect(
      deleteTabbyDownloadFolder(modelDir, resolve(outside, 'secret.txt'))
    ).resolves.toMatchObject({ ok: false })

    expect(await readFile(join(modelDir, 'keep.txt'), 'utf8')).toBe('safe')
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('nope')
  })
})

describe('hfErrorToMessage', () => {
  it('translates Tabby folder-exists 400 instead of showing raw JSON', () => {
    const message = hfErrorToMessage(
      new Error(
        'HTTP 400: {"detail":"The path models\\\\Qwen3.8-27B-exl3-SC_3.00bpw_H4 already exists. Remove the folder and try again."}'
      )
    )
    expect(message).not.toMatch(/HTTP 400/)
    expect(message).toContain('Qwen3.8-27B-exl3-SC_3.00bpw_H4')
    expect(message.toLowerCase()).not.toContain('hf_')
  })

  it('never echoes a Hugging Face token from an error string', () => {
    const message = hfErrorToMessage(
      new Error('HTTP 401 Bearer hf_secret_value The path models\\foo already exists.')
    )
    expect(message).not.toContain('hf_secret_value')
    expect(message).toContain('foo')
  })

  it('translates truncated payload and Windows lock errors without raw JSON', () => {
    const truncated = hfErrorToMessage(
      new Error(
        'HTTP 400: {"detail":"ClientPayloadError: Response payload is not completed: ContentLengthError"}'
      )
    )
    expect(truncated).not.toMatch(/HTTP|ClientPayload|ContentLength|JSON/i)
    expect(truncated).toMatch(/Hugging Face/i)

    const locked = hfErrorToMessage(
      new Error('PermissionError: [WinError 32] file is being used by another process')
    )
    expect(locked).not.toMatch(/WinError|PermissionError/i)
  })
})

describe('runTabbyHfDownload preflight', () => {
  beforeEach(() => {
    setTabbyPatchReadiness({ externalProcess: false, runtimePatchValid: true })
  })
  it('returns a folder conflict and does not call Tabby when the target exists', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    const modelDir = await tempModelDir()
    const folder = join(modelDir, 'my-model')
    mkdirSync(folder)
    writeFileSync(join(folder, 'x.bin'), 'partial')

    let called = false
    const result = await runTabbyHfDownload({
      req: { repoId: 'org/my-model' },
      operationId: 't1',
      modelDir,
      emit: () => {},
      download: async () => {
        called = true
        return { downloadPath: folder }
      }
    })

    expect(called).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.folderConflict?.folderName).toBe('my-model')
    expect(result.folderConflict?.completeness).toBe('unknown')
    expect(result.folderConflict?.suggestedFolderName).toBe('my-model-2')
    expect(result.error).toContain('my-model')
    expect(result.error ?? '').not.toMatch(/HTTP 400/)
  })

  it('calls Tabby download when the target folder does not exist', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    const modelDir = await tempModelDir()
    let called = false
    const result = await runTabbyHfDownload({
      req: { repoId: 'org/my-model' },
      operationId: 't2',
      modelDir,
      emit: () => {},
      download: async () => {
        called = true
        mkdirSync(join(modelDir, 'my-model'))
        return { downloadPath: join(modelDir, 'my-model') }
      }
    })
    expect(called).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.folderConflict).toBeUndefined()
  })

  it('allows only one POST-equivalent download during rapid concurrent calls', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    const modelDir = await tempModelDir()
    let called = 0
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const download = async (): Promise<{ downloadPath: string }> => {
      called += 1
      entered()
      await blocked
      mkdirSync(join(modelDir, 'my-model'))
      return { downloadPath: join(modelDir, 'my-model') }
    }

    const first = runTabbyHfDownload({
      req: { repoId: 'org/my-model' },
      operationId: 'rapid-1',
      modelDir,
      emit: () => {},
      download
    })
    const second = runTabbyHfDownload({
      req: { repoId: 'org/my-model' },
      operationId: 'rapid-2',
      modelDir,
      emit: () => {},
      download
    })

    await started
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(called).toBe(1)
    release()
    const results = await Promise.all([first, second])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => result.alreadyRunning)).toHaveLength(1)
  })

  it('keeps a leftover partial folder attached to the error session', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    const modelDir = await tempModelDir()
    const result = await runTabbyHfDownload({
      req: { repoId: 'org/my-model' },
      operationId: 'partial-1',
      modelDir,
      emit: () => {},
      download: async () => {
        const folder = join(modelDir, 'my-model')
        mkdirSync(folder)
        writeFileSync(join(folder, 'weights.safetensors.part'), 'partial')
        throw new Error('ClientPayloadError: Response payload is not completed')
      }
    })

    expect(result.ok).toBe(false)
    expect(result.error).not.toMatch(/ClientPayloadError/i)
    expect(result.folderConflict).toMatchObject({
      folderName: 'my-model',
      completeness: 'unknown'
    })
  })
})
