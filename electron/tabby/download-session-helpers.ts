/** Čisté helpery pro Tabby HF download session — bez Electronu a I/O store. */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import {
  formatByteCount,
  redactSecrets,
  resolveSafeModelSubdir,
  type FolderConflictInfo,
  type SafeSubdirResult
} from './hf-download-helpers'

export const PERSISTED_DOWNLOAD_VERSION = 1
export const PROGRESS_LOG_PERCENT_STEP = 5
export const PROGRESS_LOG_INTERVAL_MS = 10_000

export type TabbyDownloadSessionStatus =
  | 'running'
  | 'success'
  | 'error'
  | 'interrupted'
  | 'conflict'

export interface TabbyDownloadFormSnapshot {
  repoId: string
  revision: string
  folderName: string
}

export interface TabbyDownloadSessionView {
  sequence: number
  operationId: string
  status: TabbyDownloadSessionStatus
  repoId: string
  revision: string
  folderName: string
  startedAt: number
  updatedAt: number
  downloadedBytes: number
  totalBytes: number | null
  percent: number | null
  error?: string
  folderConflict?: FolderConflictInfo
  dismissed: boolean
  bytesPerSec?: number | null
  etaSeconds?: number | null
}

export interface TabbyDownloadStatusSnapshot {
  sequence: number
  session: TabbyDownloadSessionView | null
  form: TabbyDownloadFormSnapshot
}

export interface PersistedDownloadFile {
  version: typeof PERSISTED_DOWNLOAD_VERSION
  form: TabbyDownloadFormSnapshot
  session: TabbyDownloadSessionView | null
}

const SECRET_KEY_RE = /^(token|hfToken|hf_token|apiKey|api_key|adminKey|admin_key|authorization|password|secret|accessToken|access_token)$/i
const STATUSES: TabbyDownloadSessionStatus[] = [
  'running',
  'success',
  'error',
  'interrupted',
  'conflict'
]

export function emptyDownloadForm(): TabbyDownloadFormSnapshot {
  return { repoId: '', revision: '', folderName: '' }
}

/** Rekurzivně sanitizuje stringy; token pole vynechá. */
export function sanitizeDownloadValue(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string') return redactSecrets(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((item) => sanitizeDownloadValue(item))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) continue
      out[key] = sanitizeDownloadValue(nested)
    }
    return out
  }
  return value
}

export function sanitizeDownloadSnapshot(
  snapshot: TabbyDownloadStatusSnapshot
): TabbyDownloadStatusSnapshot {
  return sanitizeDownloadValue(snapshot) as TabbyDownloadStatusSnapshot
}

export function sanitizeDownloadSessionView(
  session: TabbyDownloadSessionView
): TabbyDownloadSessionView {
  return sanitizeDownloadValue(session) as TabbyDownloadSessionView
}

export function applyDownloadStatusUpdate(
  current: TabbyDownloadStatusSnapshot | null,
  incoming: TabbyDownloadStatusSnapshot
): TabbyDownloadStatusSnapshot {
  if (current && incoming.sequence <= current.sequence) return current
  return incoming
}

export function serializeDownloadForm(req: {
  repoId?: string
  revision?: string
  folderName?: string
  token?: string
}): TabbyDownloadFormSnapshot {
  return {
    repoId: (req.repoId ?? '').trim(),
    revision: (req.revision ?? '').trim(),
    folderName: (req.folderName ?? '').trim()
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasSecretKey(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some((key) => SECRET_KEY_RE.test(key))
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asNullableNumber(value: unknown): number | null {
  if (value == null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? redactSecrets(value) : ''
}

function parseForm(raw: unknown): TabbyDownloadFormSnapshot | null {
  if (!isPlainObject(raw)) return null
  if (!('repoId' in raw) && !('revision' in raw) && !('folderName' in raw)) return null
  return serializeDownloadForm({
    repoId: asString(raw.repoId),
    revision: asString(raw.revision),
    folderName: asString(raw.folderName)
  })
}

function parseConflict(raw: unknown): FolderConflictInfo | undefined {
  if (!isPlainObject(raw)) return undefined
  const completeness = raw.completeness
  if (completeness !== 'complete' && completeness !== 'partial' && completeness !== 'unknown') {
    return undefined
  }
  return {
    folderName: asString(raw.folderName),
    bytesOnDisk: Math.max(0, asFiniteNumber(raw.bytesOnDisk)),
    expectedBytes: asNullableNumber(raw.expectedBytes),
    completeness,
    suggestedFolderName: asString(raw.suggestedFolderName)
  }
}

function parseSession(raw: unknown): TabbyDownloadSessionView | null {
  if (raw == null) return null
  if (!isPlainObject(raw)) return null
  const status = raw.status
  if (typeof status !== 'string' || !STATUSES.includes(status as TabbyDownloadSessionStatus)) {
    return null
  }
  const folderName = asString(raw.folderName)
  if (!folderName) return null
  const error = raw.error != null ? asString(raw.error) : undefined
  const conflict = parseConflict(raw.folderConflict)
  return {
    sequence: Math.max(0, asFiniteNumber(raw.sequence)),
    operationId: asString(raw.operationId) || 'dl-unknown',
    status: status as TabbyDownloadSessionStatus,
    repoId: asString(raw.repoId),
    revision: asString(raw.revision),
    folderName,
    startedAt: Math.max(0, asFiniteNumber(raw.startedAt)),
    updatedAt: Math.max(0, asFiniteNumber(raw.updatedAt)),
    downloadedBytes: Math.max(0, asFiniteNumber(raw.downloadedBytes)),
    totalBytes: asNullableNumber(raw.totalBytes),
    percent: asNullableNumber(raw.percent),
    error: error || undefined,
    folderConflict: conflict,
    dismissed: raw.dismissed === true
  }
}

export function snapshotContainsSecrets(value: unknown): boolean {
  if (value == null) return false
  const json = JSON.stringify(value)
  if (/\bhf_[A-Za-z0-9._-]{8,}/.test(json)) return true
  if (/Bearer\s+(?!\*\*\*)\S+/i.test(json)) return true
  if (/"token"\s*:/i.test(json)) return true
  return false
}

export function serializePersistedDownloadFile(input: {
  form: TabbyDownloadFormSnapshot
  session: TabbyDownloadSessionView | null
}): string {
  const session = input.session
    ? {
        sequence: input.session.sequence,
        operationId: input.session.operationId,
        status: input.session.status,
        repoId: input.session.repoId,
        revision: input.session.revision,
        folderName: input.session.folderName,
        startedAt: input.session.startedAt,
        updatedAt: input.session.updatedAt,
        downloadedBytes: input.session.downloadedBytes,
        totalBytes: input.session.totalBytes,
        percent: input.session.percent,
        error: input.session.error ? redactSecrets(input.session.error) : undefined,
        folderConflict: input.session.folderConflict,
        dismissed: input.session.dismissed
      }
    : null
  const payload: PersistedDownloadFile = {
    version: PERSISTED_DOWNLOAD_VERSION,
    form: serializeDownloadForm(input.form),
    session
  }
  return JSON.stringify(payload, null, 2)
}

export function parsePersistedDownloadFile(raw: string): PersistedDownloadFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  if (parsed.version !== PERSISTED_DOWNLOAD_VERSION) return null
  if (hasSecretKey(parsed) && parsed.form == null) return null
  const form = parseForm(parsed.form) ?? emptyDownloadForm()
  const session = parseSession(parsed.session)
  const file: PersistedDownloadFile = {
    version: PERSISTED_DOWNLOAD_VERSION,
    form,
    session
  }
  if (snapshotContainsSecrets(file)) {
    if (file.session?.error) file.session.error = redactSecrets(file.session.error)
    if (snapshotContainsSecrets(file)) return null
  }
  return file
}

export function writeAtomicJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp`
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  writeFileSync(tmp, body, 'utf-8')
  renameSync(tmp, filePath)
}

export function classifyRecoveredSession(opts: {
  now: number
  bytesOnDisk: number
  persisted: PersistedDownloadFile
}): {
  form: TabbyDownloadFormSnapshot
  session: TabbyDownloadSessionView | null
  didRestoreIncomplete: boolean
} {
  const form = serializeDownloadForm(opts.persisted.form)
  const prev = opts.persisted.session
  if (!prev || prev.dismissed) {
    return { form, session: null, didRestoreIncomplete: false }
  }
  if (prev.status === 'success') {
    return { form, session: null, didRestoreIncomplete: false }
  }
  const bytes = Math.max(0, opts.bytesOnDisk)
  if (prev.status === 'running') {
    const total = prev.totalBytes
    let percent = prev.percent
    if (total != null && total > 0) {
      percent = Math.min(99, Math.round((bytes / total) * 100))
    }
    return {
      form,
      session: {
        ...prev,
        status: 'interrupted',
        downloadedBytes: bytes,
        percent,
        updatedAt: opts.now,
        dismissed: false,
        bytesPerSec: null,
        etaSeconds: null
      },
      didRestoreIncomplete: true
    }
  }
  return {
    form,
    session: {
      ...prev,
      downloadedBytes: bytes > 0 ? bytes : prev.downloadedBytes,
      updatedAt: opts.now,
      dismissed: false,
      bytesPerSec: null,
      etaSeconds: null
    },
    didRestoreIncomplete: false
  }
}

export function guardedFolderFromPersisted(modelDir: string, folderName: string): SafeSubdirResult {
  return resolveSafeModelSubdir(modelDir, folderName)
}

export function shouldLogProgress(
  prev: { loggedAt: number; loggedPercent: number | null; loggedBytes: number },
  next: { now: number; percent: number | null; bytesDownloaded: number }
): boolean {
  if (next.now - prev.loggedAt >= PROGRESS_LOG_INTERVAL_MS) return true
  if (next.percent != null && prev.loggedPercent != null) {
    if (next.percent - prev.loggedPercent >= PROGRESS_LOG_PERCENT_STEP) return true
  }
  return false
}

export type DownloadLogKind = 'start' | 'progress' | 'complete' | 'interrupted' | 'error' | 'restored'

function formatSizes(downloaded?: number, total?: number | null): string {
  const left = downloaded != null ? formatByteCount(downloaded) : '?'
  const right = total == null ? '?' : formatByteCount(total)
  return `${left} / ${right}`
}

export function formatDownloadLogLine(
  kind: DownloadLogKind,
  info: {
    repoId: string
    revision?: string
    folderName: string
    downloadedBytes?: number
    totalBytes?: number | null
    percent?: number | null
    bytesPerSec?: number | null
    etaSeconds?: number | null
    error?: string
  }
): string {
  const repo = redactSecrets(info.repoId || '?')
  const revision = redactSecrets(info.revision || '')
  const folder = redactSecrets(info.folderName || '?')
  const sizes = formatSizes(info.downloadedBytes, info.totalBytes)
  const percent =
    info.percent != null && Number.isFinite(info.percent) ? ` (${Math.round(info.percent)} %)` : ''
  const speed =
    info.bytesPerSec != null && Number.isFinite(info.bytesPerSec) && info.bytesPerSec > 0
      ? ` ${formatByteCount(info.bytesPerSec)}/s`
      : ''
  const eta =
    info.etaSeconds != null && Number.isFinite(info.etaSeconds) && info.etaSeconds > 0
      ? ` eta=${Math.round(info.etaSeconds)}s`
      : ''
  const rev = revision ? ` revision=${revision}` : ''
  const prefix = '[studio] tabby-download'
  switch (kind) {
    case 'start':
      return `${prefix} start repo=${repo}${rev} folder=${folder} expected=${info.totalBytes == null ? '?' : formatByteCount(info.totalBytes)}`
    case 'progress':
      return `${prefix} progress repo=${repo} folder=${folder} ${sizes}${percent}${speed}${eta}`
    case 'complete':
      return `${prefix} complete repo=${repo} folder=${folder} ${sizes}${percent || ' (100 %)'}`
    case 'interrupted':
      return `${prefix} interrupted repo=${repo} folder=${folder} ${sizes}`
    case 'error': {
      const err = redactSecrets(info.error ?? 'error')
      return `${prefix} error repo=${repo} folder=${folder} ${sizes} — ${err}`
    }
    case 'restored':
      return `${prefix} obnovena nedokončená session repo=${repo}${rev} folder=${folder} disk=${sizes}`
  }
}

export function canStartDownload(
  session: TabbyDownloadSessionView | null
): { ok: true } | { ok: false; reason: 'already-running'; session: TabbyDownloadSessionView } {
  if (session?.status === 'running' && !session.dismissed) {
    return { ok: false, reason: 'already-running', session }
  }
  return { ok: true }
}

export function computeReliableSpeed(opts: {
  prevBytes: number
  prevAt: number
  nextBytes: number
  nextAt: number
  totalBytes: number | null
}): { bytesPerSec: number | null; etaSeconds: number | null } {
  const dtSec = (opts.nextAt - opts.prevAt) / 1000
  const db = opts.nextBytes - opts.prevBytes
  if (dtSec < 2 || db <= 0) return { bytesPerSec: null, etaSeconds: null }
  const bytesPerSec = db / dtSec
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return { bytesPerSec: null, etaSeconds: null }
  }
  let etaSeconds: number | null = null
  if (opts.totalBytes != null && opts.totalBytes > opts.nextBytes) {
    etaSeconds = (opts.totalBytes - opts.nextBytes) / bytesPerSec
    if (!Number.isFinite(etaSeconds) || etaSeconds <= 0) etaSeconds = null
  }
  return { bytesPerSec, etaSeconds }
}
