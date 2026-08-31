import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LogBuffer } from '../ollama/log-buffer'
import {
  _resetSecretRegistryForTests,
  registerSecret
} from './secret-redactor'
import {
  clearStudioLogs,
  openStudioLogWriter,
  prepareStudioLogScrub,
  resetStudioLogPersistenceForTests,
  StudioLogPersistenceError,
  withBackendLogMutex
} from './studio-log-persistence'
import { scrubLogFileAtomic } from './log-scrub'

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  _resetSecretRegistryForTests()
  resetStudioLogPersistenceForTests()
  await new Promise((r) => setTimeout(r, 10))
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('studio log persistence mutex', () => {
  it('two concurrent inits — scrub completes before writer opens', async () => {
    registerSecret('synthetic-writer-key-006')
    const dir = tempDir('log-mutex-')
    writeFileSync(join(dir, 'ollama-serve.log'), 'token=synthetic-writer-key-006\n', 'utf8')
    writeFileSync(join(dir, 'tabby-serve.log'), 'token=synthetic-writer-key-006\n', 'utf8')

    await Promise.all([
      openStudioLogWriter(dir, 'ollama-serve.log'),
      openStudioLogWriter(dir, 'tabby-serve.log')
    ])

    expect(readFileSync(join(dir, 'ollama-serve.log'), 'utf8')).not.toContain(
      'synthetic-writer-key-006'
    )
    expect(readFileSync(join(dir, 'tabby-serve.log'), 'utf8')).not.toContain(
      'synthetic-writer-key-006'
    )
  })

  it('writer does not append before scrub finishes', async () => {
    registerSecret('synthetic-pre-scrub-009')
    const dir = tempDir('log-pre-scrub-')
    writeFileSync(join(dir, 'tabby-serve.log'), 'pre synthetic-pre-scrub-009\n', 'utf8')

    let scrubDone = false
    const scrubPromise = prepareStudioLogScrub(dir).then(() => {
      scrubDone = true
    })
    const writerPromise = openStudioLogWriter(dir, 'tabby-serve.log')

    await Promise.all([scrubPromise, writerPromise])
    expect(scrubDone).toBe(true)
    expect(readFileSync(join(dir, 'tabby-serve.log'), 'utf8')).not.toContain(
      'synthetic-pre-scrub-009'
    )
  })

  it('clear logs — RAM path via mutex and empty disk files', async () => {
    registerSecret('synthetic-clear-key-007')
    const dir = tempDir('log-clear-')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ollama-serve.log'), 'leak synthetic-clear-key-007\n', 'utf8')
    await prepareStudioLogScrub(dir)
    await openStudioLogWriter(dir, 'ollama-serve.log')
    await clearStudioLogs(dir, true)
    expect(readFileSync(join(dir, 'ollama-serve.log'), 'utf8')).toBe('')
  })

  it('mutex serializes scrub then writer on same dir', async () => {
    const dir = tempDir('log-serial-')
    await prepareStudioLogScrub(dir)
    await openStudioLogWriter(dir, 'tabby-serve.log')
    expect(existsSync(join(dir, 'tabby-serve.log'))).toBe(true)
  })

  it('junction/symlink target outside root — scrub fail-closes', async () => {
    const root = tempDir('log-root-')
    const outside = tempDir('log-outside-')
    const secret = 'synthetic-junction-key-008'
    registerSecret(secret)
    writeFileSync(join(outside, 'secret.log'), `key ${secret}\n`, 'utf8')
    const link = join(root, 'escape.log')
    try {
      const { symlinkSync } = await import('fs')
      symlinkSync(join(outside, 'secret.log'), link)
    } catch {
      return
    }
    const result = await scrubLogFileAtomic(link, { allowedRoots: [root] })
    expect(result.ok).toBe(false)
    expect(readFileSync(join(outside, 'secret.log'), 'utf8')).toContain(secret)
  })

  it('scrub reject — writer is not opened', async () => {
    const dir = tempDir('log-scrub-reject-')
    const outside = tempDir('log-scrub-outside-')
    const secret = 'synthetic-scrub-reject-key-010'
    registerSecret(secret)
    writeFileSync(join(outside, 'ollama-serve.log'), `token=${secret}\n`, 'utf8')
    try {
      const { symlinkSync } = await import('fs')
      symlinkSync(join(outside, 'ollama-serve.log'), join(dir, 'ollama-serve.log'))
    } catch {
      return
    }
    await expect(prepareStudioLogScrub(dir)).rejects.toBeInstanceOf(StudioLogPersistenceError)
    await expect(openStudioLogWriter(dir, 'ollama-serve.log')).rejects.toBeInstanceOf(
      StudioLogPersistenceError
    )
    expect(readFileSync(join(outside, 'ollama-serve.log'), 'utf8')).toContain(secret)
  })

  it('symlink log path — open and clear reject without mutating external target', async () => {
    const dir = tempDir('log-symlink-open-')
    const outside = tempDir('log-symlink-outside-')
    const secret = 'synthetic-symlink-open-key-011'
    registerSecret(secret)
    const externalPath = join(outside, 'tabby-serve.log')
    writeFileSync(externalPath, `keep ${secret}\n`, 'utf8')
    try {
      const { symlinkSync } = await import('fs')
      symlinkSync(externalPath, join(dir, 'tabby-serve.log'))
    } catch {
      return
    }
    writeFileSync(join(dir, 'ollama-serve.log'), '', 'utf8')
    await expect(openStudioLogWriter(dir, 'tabby-serve.log')).rejects.toBeInstanceOf(
      StudioLogPersistenceError
    )
    const externalBefore = readFileSync(externalPath, 'utf8')
    try {
      const { symlinkSync, unlinkSync } = await import('fs')
      unlinkSync(join(dir, 'ollama-serve.log'))
      symlinkSync(externalPath, join(dir, 'ollama-serve.log'))
    } catch {
      return
    }
    await expect(clearStudioLogs(dir, true)).rejects.toBeInstanceOf(StudioLogPersistenceError)
    expect(readFileSync(externalPath, 'utf8')).toBe(externalBefore)
  })
})
