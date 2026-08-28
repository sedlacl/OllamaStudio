/** Čisté helpery pro HF download — bez I/O, tokenu a logování. */

import { isAbsolute, relative, resolve } from 'path'
import { sanitizeSecrets } from '../security/secret-redactor'

export type HfRefType = 'branch' | 'tag'

export interface HfRevision {
  name: string
  type: HfRefType
}

export type HfErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'http_error'
  | 'network'
  | 'invalid_json'

export class HfApiError extends Error {
  readonly code: HfErrorCode
  readonly status?: number

  constructor(code: HfErrorCode, status?: number, options?: ErrorOptions) {
    super(code, options)
    this.name = 'HfApiError'
    this.code = code
    this.status = status
  }
}

export function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`
  return `${Math.round(bytes)} B`
}

export function describeInterruptedDownload(opts: {
  downloaded: number
  total: number | null
}): { downloaded: string; total: string } {
  return {
    downloaded: formatByteCount(opts.downloaded),
    total: opts.total == null ? '?' : formatByteCount(opts.total)
  }
}

export function hfErrorCodeFromStatus(status: number): HfErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  return 'http_error'
}

/** Odstraní Bearer i hf_ tokeny z libovolného textu (chybové hlášky, URL). */
export function redactSecrets(text: string): string {
  return sanitizeSecrets(text)
}

export function normalizeRepoId(input: string): string {
  let s = input.trim()
  s = s.replace(/^https?:\/\/huggingface\.co\//i, '')
  s = s.replace(/^(models|datasets)\//i, '')
  s = s.replace(/\/+$/, '')
  return s
}

export function hfApiRepoPath(repoId: string): string {
  return normalizeRepoId(repoId)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function sanitizeFolderSegment(raw: string): string {
  let s = raw.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
  s = s.replace(/[. ]+$/g, '')
  if (!s) return 'model'
  if (WINDOWS_RESERVED.test(s)) return `${s}-model`
  if (s.length > 120) s = s.slice(0, 120)
  return s
}

/** Jedna složka pod modelDir — bez path traversal. */
export function sanitizeFolderName(name: string): string {
  const flattened = name.replace(/[/\\]/g, '-').replace(/^\.+/, '').replace(/^-+/, '')
  return sanitizeFolderSegment(flattened)
}

/**
 * Stabilní default složky: `<repo-basename>-<revision>`.
 * Prázdná nebo `main` revision → jen basename (case-insensitive).
 */
export function deriveFolderName(repoId: string, revision?: string): string {
  const id = normalizeRepoId(repoId)
  const parts = id.split('/').filter(Boolean)
  const basename = sanitizeFolderSegment(parts[parts.length - 1] ?? id)
  const rev = (revision ?? '').trim()
  if (!rev || rev.toLowerCase() === 'main') return basename
  return `${basename}-${sanitizeFolderSegment(rev)}`
}

export function resolveDownloadFolderName(
  repoId: string,
  revision: string | undefined,
  folderName?: string
): string {
  const override = folderName?.trim()
  if (override) return sanitizeFolderName(override)
  return deriveFolderName(repoId, revision)
}

export function parseHfRefsResponse(data: unknown): HfRevision[] {
  if (!data || typeof data !== 'object') return []
  const obj = data as Record<string, unknown>
  const out: HfRevision[] = []
  const seen = new Set<string>()

  const take = (raw: unknown, type: HfRefType): void => {
    if (!Array.isArray(raw)) return
    for (const item of raw) {
      let name: string | undefined
      if (typeof item === 'string') name = item
      else if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
        name = (item as { name: string }).name
      }
      const trimmed = name?.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      out.push({ name: trimmed, type })
    }
  }

  take(obj.branches, 'branch')
  take(obj.tags, 'tag')
  return out
}

function entryByteSize(entry: unknown): number | null {
  if (!entry || typeof entry !== 'object') return null
  const o = entry as { type?: unknown; size?: unknown; lfs?: unknown }
  if (o.type === 'directory') return null
  let lfsSize: unknown
  if (o.lfs && typeof o.lfs === 'object') {
    lfsSize = (o.lfs as { size?: unknown }).size
  }
  const n = typeof lfsSize === 'number' ? lfsSize : o.size
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
  return n
}

export function parseHfTreeSize(data: unknown): number | null {
  if (typeof data === 'number' && Number.isFinite(data) && data > 0) return data
  if (!data || typeof data !== 'object') return null
  const size = (data as { size?: unknown }).size
  if (typeof size === 'number' && Number.isFinite(size) && size > 0) return size
  return null
}

export function sumHfSiblingSizes(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null
  const siblings = (data as { siblings?: unknown }).siblings
  if (!Array.isArray(siblings) || siblings.length === 0) return null
  let total = 0
  let any = false
  for (const sibling of siblings) {
    const n = entryByteSize(sibling)
    if (n != null) {
      total += n
      any = true
    }
  }
  return any && total > 0 ? total : null
}

export function sumHfTreeSizes(data: unknown): number | null {
  const arr = Array.isArray(data) ? data : null
  if (!arr || arr.length === 0) return null
  let total = 0
  let anyFile = false
  for (const entry of arr) {
    const n = entryByteSize(entry)
    if (n != null) {
      total += n
      anyFile = true
    }
  }
  return anyFile && total > 0 ? total : null
}

export interface DownloadProgressSample {
  percent: number | null
  bytesDownloaded: number
  bytesTotal: number | null
}

/**
 * Pravdivý progress: nikdy neklesá, nikdy 100 % dokud volající neoznačí dokončení.
 * `bytesTotal` null/<=0 → percent null (indeterminate).
 */
export function calculateDownloadProgress(input: {
  bytesOnDisk: number
  bytesTotal: number | null
  baseline: number
  previousMaxBytes: number
  previousPercent: number | null
}): DownloadProgressSample {
  const onDisk = Number.isFinite(input.bytesOnDisk) ? Math.max(0, input.bytesOnDisk) : 0
  const baseline = Number.isFinite(input.baseline) ? Math.max(0, input.baseline) : 0
  const prevMax = Number.isFinite(input.previousMaxBytes)
    ? Math.max(0, input.previousMaxBytes)
    : 0
  const bytesDownloaded = Math.max(onDisk, baseline, prevMax)

  const total =
    input.bytesTotal != null && Number.isFinite(input.bytesTotal) && input.bytesTotal > 0
      ? input.bytesTotal
      : null

  if (total == null) {
    return { percent: null, bytesDownloaded, bytesTotal: null }
  }

  let percent = Math.round((bytesDownloaded / total) * 100)
  if (!Number.isFinite(percent) || percent < 0) percent = 0
  if (percent >= 100) percent = 99
  if (input.previousPercent != null && Number.isFinite(input.previousPercent)) {
    percent = Math.max(percent, Math.min(99, Math.max(0, input.previousPercent)))
  }

  return { percent, bytesDownloaded, bytesTotal: total }
}

export function completeDownloadProgress(input: {
  bytesDownloaded: number
  bytesTotal: number | null
}): DownloadProgressSample {
  const total =
    input.bytesTotal != null && Number.isFinite(input.bytesTotal) && input.bytesTotal > 0
      ? input.bytesTotal
      : null
  const downloaded = Number.isFinite(input.bytesDownloaded)
    ? Math.max(0, input.bytesDownloaded)
    : 0
  return {
    percent: 100,
    bytesDownloaded: downloaded,
    bytesTotal: total
  }
}

export type FolderCompleteness = 'complete' | 'partial' | 'unknown'

export interface FolderConflictInfo {
  folderName: string
  bytesOnDisk: number
  expectedBytes: number | null
  completeness: FolderCompleteness
  suggestedFolderName: string
}

export type SafeSubdirReason = 'empty_name' | 'empty_root' | 'not_subdir' | 'is_root'

export type SafeSubdirResult =
  | { ok: true; folderName: string; resolved: string }
  | { ok: false; reason: SafeSubdirReason }

function normalizePathForCompare(p: string): string {
  const resolved = resolve(p)
  const trimmed = resolved.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** True jen když je `child` ostře uvnitř `parent` (ne stejná cesta, žádný `..` / jiný disk). */
export function isPathStrictlyInside(parent: string, child: string): boolean {
  const root = resolve(parent)
  const target = resolve(child)
  if (normalizePathForCompare(root) === normalizePathForCompare(target)) return false
  const rel = relative(root, target)
  if (!rel) return false
  if (isAbsolute(rel)) return false
  const first = rel.split(/[/\\]/)[0]
  return first !== '..'
}

/**
 * Jedna složka přímo pod modelDir. Odmítne prázdný název, absolutní cestu,
 * separátory i path traversal — před i po resolve.
 */
export function resolveSafeModelSubdir(modelDir: string, folderName: string): SafeSubdirResult {
  const root = modelDir.trim()
  if (!root) return { ok: false, reason: 'empty_root' }

  const raw = folderName.trim()
  if (!raw) return { ok: false, reason: 'empty_name' }
  if (raw === '.' || raw === '..') return { ok: false, reason: 'not_subdir' }
  if (raw.includes('..')) return { ok: false, reason: 'not_subdir' }
  if (/[/\\]/.test(raw)) return { ok: false, reason: 'not_subdir' }
  if (isAbsolute(raw)) return { ok: false, reason: 'not_subdir' }

  const sanitized = sanitizeFolderName(raw)
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return { ok: false, reason: 'empty_name' }
  }
  if (/[/\\]/.test(sanitized) || sanitized.includes('..') || isAbsolute(sanitized)) {
    return { ok: false, reason: 'not_subdir' }
  }

  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(resolvedRoot, sanitized)
  if (normalizePathForCompare(resolvedRoot) === normalizePathForCompare(resolvedTarget)) {
    return { ok: false, reason: 'is_root' }
  }
  if (!isPathStrictlyInside(resolvedRoot, resolvedTarget)) {
    return { ok: false, reason: 'not_subdir' }
  }
  const rel = relative(resolvedRoot, resolvedTarget)
  if (!rel || rel.split(/[/\\]/).filter(Boolean).length !== 1) {
    return { ok: false, reason: 'not_subdir' }
  }
  return { ok: true, folderName: sanitized, resolved: resolvedTarget }
}

export function classifyFolderCompleteness(
  bytesOnDisk: number,
  expectedBytes: number | null
): FolderCompleteness {
  if (expectedBytes == null || !Number.isFinite(expectedBytes) || expectedBytes <= 0) {
    return 'unknown'
  }
  const onDisk = Number.isFinite(bytesOnDisk) ? Math.max(0, bytesOnDisk) : 0
  if (onDisk >= expectedBytes) return 'complete'
  return 'partial'
}

export function nextAvailableFolderName(baseName: string, existing: Iterable<string>): string {
  const sanitized = sanitizeFolderName(baseName)
  const taken = new Set(
    [...existing].map((name) => name.trim()).filter(Boolean).map((name) => name.toLowerCase())
  )
  if (!taken.has(sanitized.toLowerCase())) return sanitized
  for (let n = 2; n < 10_000; n++) {
    const candidate = sanitizeFolderName(`${sanitized}-${n}`)
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return sanitizeFolderName(`${sanitized}-alt`)
}

export function describeExistingFolder(input: {
  folderName: string
  bytesOnDisk: number
  expectedBytes: number | null
  siblingNames: string[]
}): FolderConflictInfo {
  const folderName = sanitizeFolderName(input.folderName)
  const bytesOnDisk = Number.isFinite(input.bytesOnDisk) ? Math.max(0, input.bytesOnDisk) : 0
  const expectedBytes =
    input.expectedBytes != null && Number.isFinite(input.expectedBytes) && input.expectedBytes > 0
      ? input.expectedBytes
      : null
  return {
    folderName,
    bytesOnDisk,
    expectedBytes,
    completeness: classifyFolderCompleteness(bytesOnDisk, expectedBytes),
    suggestedFolderName: nextAvailableFolderName(folderName, input.siblingNames)
  }
}

const TABBY_PATH_EXISTS_RE = /The path\s+(.+?)\s+already exists/i

/** Vytáhne název složky z Tabby 400 „path already exists“, nebo null když to není tahle chyba. */
export function parseTabbyFolderExistsError(text: string): string | null {
  const redacted = redactSecrets(text)
  const matched = redacted.match(TABBY_PATH_EXISTS_RE)
  if (matched) {
    const pathPart = matched[1].replace(/^["']|["']$/g, '').trim()
    const segments = pathPart.split(/[/\\]+/).filter(Boolean)
    return segments[segments.length - 1] ?? pathPart
  }
  if (/already exists\.?\s*Remove the folder and try again/i.test(redacted)) {
    return 'folder'
  }
  return null
}
