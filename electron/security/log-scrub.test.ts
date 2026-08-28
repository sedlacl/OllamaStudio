import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { scrubLogFileAtomic } from './log-scrub'
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
})
