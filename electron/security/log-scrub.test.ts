import { execSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { scrubLogFileAtomic, truncateStudioLogFiles } from './log-scrub'
import { registerSecret, _resetSecretRegistryForTests } from './secret-redactor'

const dirs: string[] = []

afterEach(() => {
  _resetSecretRegistryForTests()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('log-scrub', () => {
  it('atomically scrubs known secrets and keeps normal lines', async () => {
    registerSecret('synthetic-scrub-key-xyz')
    const dir = mkdtempSync(join(tmpdir(), 'log-scrub-'))
    dirs.push(dir)
    const path = join(dir, 'tabby-serve.log')
    writeFileSync(
      path,
      ['normal startup line', 'Your API key is: synthetic-scrub-key-xyz', 'metrics ok'].join('\n'),
      'utf8'
    )

    const result = await scrubLogFileAtomic(path, { allowedRoots: [dir] })
    expect(result.ok).toBe(true)
    expect(result.linesChanged).toBe(1)
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('normal startup line')
    expect(content).toContain('metrics ok')
    expect(content).not.toContain('synthetic-scrub-key-xyz')
  })

  it('truncateStudioLogFiles — truncates known logs inside root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-truncate-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'ollama-serve.log'), 'keep cleared\n', 'utf8')
    writeFileSync(join(dir, 'tabby-serve.log'), 'keep cleared\n', 'utf8')

    truncateStudioLogFiles(dir)

    expect(readFileSync(join(dir, 'ollama-serve.log'), 'utf8')).toBe('')
    expect(readFileSync(join(dir, 'tabby-serve.log'), 'utf8')).toBe('')
  })

  it('truncateStudioLogFiles — junction/symlink outside root rejects without mutating target', () => {
    const root = mkdtempSync(join(tmpdir(), 'log-truncate-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'log-truncate-outside-'))
    dirs.push(root, outside)
    const secret = 'synthetic-truncate-junction-key-012'
    registerSecret(secret)
    const externalPath = join(outside, 'ollama-serve.log')
    writeFileSync(externalPath, `keep ${secret}\n`, 'utf8')
    writeFileSync(join(root, 'tabby-serve.log'), '', 'utf8')

    const linkPath = join(root, 'ollama-serve.log')
    try {
      symlinkSync(externalPath, linkPath)
    } catch {
      try {
        execSync(`cmd /c mklink /J "${linkPath}" "${outside}"`, { stdio: 'ignore' })
      } catch {
        return
      }
    }

    expect(() => truncateStudioLogFiles(root)).toThrow(/path outside known log directories/)
    expect(readFileSync(externalPath, 'utf8')).toContain(secret)
  })
})
