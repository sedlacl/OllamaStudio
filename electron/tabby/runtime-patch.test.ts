import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import originalAuth from '../../resources/tabby/original-auth.py?raw'
import originalDownloader from '../../resources/tabby/original-downloader.py?raw'
import {
  applyTabbyRuntimePatch,
  applyTabbyRuntimePatches,
  sha256,
  sha256NormalizedText,
  verifyTabbyRuntimePatchIntegrity,
  TABBY_AUTH_ORIGINAL_SHA256,
  TABBY_AUTH_PATCHED_SHA256,
  TABBY_DOWNLOADER_ORIGINAL_SHA256,
  TABBY_DOWNLOADER_PATCHED_SHA256
} from './runtime-patch'

const dirs: string[] = []

function makeInstall(sources: Record<string, string>): string {
  const installDir = mkdtempSync(join(tmpdir(), 'tabby-patch-'))
  dirs.push(installDir)
  for (const [rel, body] of Object.entries(sources)) {
    const parts = rel.split('/')
    mkdirSync(join(installDir, ...parts.slice(0, -1)), { recursive: true })
    writeFileSync(join(installDir, ...parts), body, 'utf-8')
  }
  return installDir
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('hash-guarded Tabby runtime patches', () => {
  it('patches downloader and auth sources and is idempotent', () => {
    expect(sha256NormalizedText(originalDownloader)).toBe(TABBY_DOWNLOADER_ORIGINAL_SHA256)
    expect(sha256NormalizedText(originalAuth)).toBe(TABBY_AUTH_ORIGINAL_SHA256)
    const installDir = makeInstall({
      'common/downloader.py': originalDownloader.replace(/\r\n?/g, '\n'),
      'common/auth.py': originalAuth.replace(/\r\n?/g, '\n')
    })

    const results = applyTabbyRuntimePatches(installDir)
    expect(results.every((result) => result.ok)).toBe(true)
    expect(sha256(readFileSync(join(installDir, 'common/downloader.py')))).toBe(
      TABBY_DOWNLOADER_PATCHED_SHA256
    )
    expect(sha256(readFileSync(join(installDir, 'common/auth.py')))).toBe(
      TABBY_AUTH_PATCHED_SHA256
    )
    expect(applyTabbyRuntimePatches(installDir).every((r) => r.status === 'already-applied')).toBe(
      true
    )
  })

  it('verifyTabbyRuntimePatchIntegrity detects tampered patched files', () => {
    const installDir = makeInstall({
      'common/downloader.py': originalDownloader.replace(/\r\n?/g, '\n'),
      'common/auth.py': originalAuth.replace(/\r\n?/g, '\n')
    })
    applyTabbyRuntimePatches(installDir)
    expect(verifyTabbyRuntimePatchIntegrity(installDir).ok).toBe(true)
    const tampered = 'print("tampered")\n'
    writeFileSync(join(installDir, 'common/auth.py'), tampered, 'utf-8')
    const check = verifyTabbyRuntimePatchIntegrity(installDir)
    expect(check.ok).toBe(false)
    expect(check.invalidTargets).toContain('common/auth.py')
  })

  it('refuses an unknown Tabby source without changing it', () => {
    const unknown = 'print("different Tabby version")\n'
    const installDir = makeInstall({
      'common/downloader.py': unknown,
      'common/auth.py': originalAuth
    })
    const result = applyTabbyRuntimePatch(installDir, {
      target: 'common/downloader.py',
      originalSha256: TABBY_DOWNLOADER_ORIGINAL_SHA256,
      patchedSha256: TABBY_DOWNLOADER_PATCHED_SHA256
    })
    expect(result).toMatchObject({
      ok: false,
      status: 'unsupported-source',
      actualSha256: sha256(unknown)
    })
    expect(readFileSync(join(installDir, 'common/downloader.py'), 'utf-8')).toBe(unknown)
  })

  it('treats legacy CRLF patched downloader as already applied', () => {
    const runtimePath = join(process.env.TABBY_INSTALL_DIR || 'D:/AI/Tabby', 'common/downloader.py')
    if (!existsSync(runtimePath)) return
    const legacyCrlf = readFileSync(runtimePath) // binary — zachová CRLF bytes
    if (sha256(legacyCrlf) === TABBY_DOWNLOADER_PATCHED_SHA256) return
    const installDir = makeInstall({ 'common/downloader.py': legacyCrlf.toString('binary') })
    const result = applyTabbyRuntimePatch(installDir, {
      target: 'common/downloader.py',
      originalSha256: TABBY_DOWNLOADER_ORIGINAL_SHA256,
      patchedSha256: TABBY_DOWNLOADER_PATCHED_SHA256,
      legacyPatchedSha256: ['cda2b0452c82dc3abc040358714e042fdb3c19ea112f1dee6abf86010df7a567']
    })
    expect(result).toMatchObject({ ok: true, status: 'already-applied', target: 'common/downloader.py' })
    expect(sha256(readFileSync(join(installDir, 'common/downloader.py')))).toBe(sha256(legacyCrlf))
  })
})
