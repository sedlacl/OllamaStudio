import { createHash } from 'crypto'
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import patchedAuth from '../../resources/tabby/auth.py?raw'
import patchedDownloader from '../../resources/tabby/downloader.py?raw'
import patchManifest from '../../resources/tabby/patch-manifest.json'

export interface TabbyPatchSpec {
  target: string
  originalSha256: string
  patchedSha256: string
  /** Dříve nasazené patched hashe (např. CRLF varianta) — stále platné na disku. */
  legacyPatchedSha256?: string[]
}

export interface TabbyPatchManifest {
  version: string
  patches: TabbyPatchSpec[]
}

const manifest = patchManifest as TabbyPatchManifest

export const TABBY_RUNTIME_PATCH_VERSION = manifest.version

const PATCH_BUNDLES: Record<string, string> = {
  'common/downloader.py': patchedDownloader,
  'common/auth.py': patchedAuth
}

export type RuntimePatchResult =
  | { ok: true; status: 'applied' | 'already-applied'; version: string; target: string }
  | {
      ok: false
      status: 'missing' | 'unsupported-source' | 'invalid-bundle' | 'write-failed'
      version: string
      target: string
      actualSha256?: string
    }

export interface RuntimePatchIntegrityResult {
  ok: boolean
  invalidTargets: string[]
  details: Array<{ target: string; actualSha256: string; expectedSha256: string }>
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

export function sha256NormalizedText(data: string): string {
  return sha256(data.replace(/\r\n?/g, '\n'))
}

function knownPatchedHashes(spec: TabbyPatchSpec): Set<string> {
  return new Set([spec.patchedSha256, ...(spec.legacyPatchedSha256 ?? [])])
}

function isKnownPatchedHash(spec: TabbyPatchSpec, hash: string): boolean {
  return knownPatchedHashes(spec).has(hash)
}

/** Ověří aktuální hash patched souborů v instalaci (ne metadata z minula). */
export function verifyTabbyRuntimePatchIntegrity(installDir: string): RuntimePatchIntegrityResult {
  const invalidTargets: string[] = []
  const details: RuntimePatchIntegrityResult['details'] = []
  for (const spec of manifest.patches) {
    const source = join(installDir, ...spec.target.split('/'))
    if (!existsSync(source)) {
      invalidTargets.push(spec.target)
      details.push({
        target: spec.target,
        actualSha256: '',
        expectedSha256: spec.patchedSha256
      })
      continue
    }
    const actualSha256 = sha256(readFileSync(source))
    if (!isKnownPatchedHash(spec, actualSha256)) {
      invalidTargets.push(spec.target)
      details.push({
        target: spec.target,
        actualSha256,
        expectedSha256: spec.patchedSha256
      })
    }
  }
  return { ok: invalidTargets.length === 0, invalidTargets, details }
}

function applySinglePatch(installDir: string, spec: TabbyPatchSpec): RuntimePatchResult {
  const version = manifest.version
  const bundledSource = PATCH_BUNDLES[spec.target]
  if (!bundledSource) {
    return { ok: false, status: 'invalid-bundle', version, target: spec.target }
  }

  const source = join(installDir, ...spec.target.split('/'))
  if (!existsSync(source)) return { ok: false, status: 'missing', version, target: spec.target }

  const bundled = Buffer.from(bundledSource.replace(/\r\n?/g, '\n'), 'utf-8')
  if (sha256(bundled) !== spec.patchedSha256) {
    return { ok: false, status: 'invalid-bundle', version, target: spec.target }
  }

  const original = readFileSync(source)
  const actualSha256 = sha256(original)
  if (isKnownPatchedHash(spec, actualSha256)) {
    return { ok: true, status: 'already-applied', version, target: spec.target }
  }
  if (actualSha256 !== spec.originalSha256) {
    return { ok: false, status: 'unsupported-source', version, target: spec.target, actualSha256 }
  }

  const temporary = `${source}.${version}.tmp`
  const backup = `${source}.${version}.bak`
  let movedOriginal = false
  try {
    if (existsSync(temporary)) unlinkSync(temporary)
    if (existsSync(backup)) unlinkSync(backup)
    writeFileSync(temporary, bundled)
    renameSync(source, backup)
    movedOriginal = true
    renameSync(temporary, source)
    return { ok: true, status: 'applied', version, target: spec.target }
  } catch {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
      if (movedOriginal && !existsSync(source) && existsSync(backup)) {
        renameSync(backup, source)
      }
    } catch {
      /* The caller reports a safe generic failure; no paths or contents are logged. */
    }
    return { ok: false, status: 'write-failed', version, target: spec.target }
  }
}

export function applyTabbyRuntimePatch(
  installDir: string,
  spec: TabbyPatchSpec
): RuntimePatchResult {
  return applySinglePatch(installDir, spec)
}

/** @deprecated Use applyTabbyRuntimePatches */
export function applyTabbyDownloaderPatch(installDir: string): RuntimePatchResult {
  const spec = manifest.patches.find((p) => p.target === 'common/downloader.py')
  if (!spec) {
    return {
      ok: false,
      status: 'invalid-bundle',
      version: manifest.version,
      target: 'common/downloader.py'
    }
  }
  return applySinglePatch(installDir, spec)
}

export function applyTabbyRuntimePatches(installDir: string): RuntimePatchResult[] {
  return manifest.patches.map((spec) => applySinglePatch(installDir, spec))
}

export const TABBY_DOWNLOADER_PATCH_VERSION = TABBY_RUNTIME_PATCH_VERSION
export const TABBY_DOWNLOADER_ORIGINAL_SHA256 =
  manifest.patches.find((p) => p.target === 'common/downloader.py')?.originalSha256 ?? ''
export const TABBY_DOWNLOADER_PATCHED_SHA256 =
  manifest.patches.find((p) => p.target === 'common/downloader.py')?.patchedSha256 ?? ''
export const TABBY_AUTH_ORIGINAL_SHA256 =
  manifest.patches.find((p) => p.target === 'common/auth.py')?.originalSha256 ?? ''
export const TABBY_AUTH_PATCHED_SHA256 =
  manifest.patches.find((p) => p.target === 'common/auth.py')?.patchedSha256 ?? ''
