/** Main-owned HF download session: in-memory snapshot + userData persist. */

import { existsSync, readFileSync } from 'fs'
import {
  applyDownloadStatusUpdate,
  canStartDownload,
  classifyRecoveredSession,
  computeReliableSpeed,
  emptyDownloadForm,
  formatDownloadLogLine,
  guardedFolderFromPersisted,
  parsePersistedDownloadFile,
  sanitizeDownloadSessionView,
  sanitizeDownloadSnapshot,
  serializeDownloadForm,
  serializePersistedDownloadFile,
  shouldLogProgress,
  writeAtomicJson,
  type TabbyDownloadFormSnapshot,
  type TabbyDownloadSessionStatus,
  type TabbyDownloadSessionView,
  type TabbyDownloadStatusSnapshot
} from './download-session-helpers'
import { describeExistingFolder, type FolderConflictInfo } from './hf-download-helpers'

export type {
  TabbyDownloadFormSnapshot,
  TabbyDownloadSessionStatus,
  TabbyDownloadSessionView,
  TabbyDownloadStatusSnapshot
} from './download-session-helpers'

export interface DownloadSession {
  operationId: string
  folderName: string
  bytesDownloaded: number
  bytesTotal: number | null
}

export interface BeginDownloadInput {
  operationId: string
  repoId: string
  revision?: string
  folderName: string
  downloadedBytes: number
  totalBytes: number | null
}

export type BeginDownloadResult =
  | { ok: true; snapshot: TabbyDownloadStatusSnapshot }
  | { ok: false; reason: 'already-running'; snapshot: TabbyDownloadStatusSnapshot }

type LogLevel = 'info' | 'error' | 'warn'

interface StoreHooks {
  persistFile: string | null
  now: () => number
  log: (level: LogLevel, text: string) => void
  emit: (snapshot: TabbyDownloadStatusSnapshot) => void
}

const defaultHooks: StoreHooks = {
  persistFile: null,
  now: () => Date.now(),
  log: () => {},
  emit: () => {}
}

let hooks: StoreHooks = { ...defaultHooks }
let inFlight: DownloadSession | null = null
let interruptedByBackend = false
let sequence = 0
let form: TabbyDownloadFormSnapshot = emptyDownloadForm()
let view: TabbyDownloadSessionView | null = null
let lastProgressLog = { loggedAt: 0, loggedPercent: null as number | null, loggedBytes: 0 }
let speedSample = { bytes: 0, at: 0 }

export function configureDownloadSession(partial: Partial<StoreHooks>): void {
  hooks = { ...hooks, ...partial }
}

export function getDownloadStatusSnapshot(): TabbyDownloadStatusSnapshot {
  const session =
    view && !view.dismissed
      ? sanitizeDownloadSessionView({ ...view, sequence })
      : null
  return sanitizeDownloadSnapshot({ sequence, session, form: { ...form } })
}

function bump(): number {
  sequence += 1
  return sequence
}

function persistAndEmit(): void {
  if (view) view = sanitizeDownloadSessionView({ ...view, sequence })
  form = serializeDownloadForm(form)
  if (hooks.persistFile) {
    writeAtomicJson(
      hooks.persistFile,
      serializePersistedDownloadFile({ form, session: view })
    )
  }
  hooks.emit(getDownloadStatusSnapshot())
}

/** Po rotaci klíčů znovu sanitizuje RAM snapshot a emitne bezpečný stav. */
export function resanitizeDownloadSessionSnapshot(): TabbyDownloadStatusSnapshot {
  if (view) view = sanitizeDownloadSessionView(view)
  form = serializeDownloadForm(form)
  persistAndEmit()
  return getDownloadStatusSnapshot()
}

function logLine(
  kind: Parameters<typeof formatDownloadLogLine>[0],
  extra?: { error?: string }
): void {
  const src = view
  if (!src && kind !== 'start') return
  const line = formatDownloadLogLine(kind, {
    repoId: src?.repoId ?? form.repoId,
    revision: src?.revision || form.revision,
    folderName: src?.folderName ?? form.folderName,
    downloadedBytes: src?.downloadedBytes,
    totalBytes: src?.totalBytes ?? null,
    percent: src?.percent,
    bytesPerSec: src?.bytesPerSec,
    etaSeconds: src?.etaSeconds,
    error: extra?.error ?? src?.error
  })
  const level: LogLevel = kind === 'error' ? 'error' : kind === 'interrupted' || kind === 'restored' ? 'warn' : 'info'
  hooks.log(level, line)
}

export function rememberDownloadForm(req: {
  repoId?: string
  revision?: string
  folderName?: string
  token?: string
}): TabbyDownloadStatusSnapshot {
  form = serializeDownloadForm(req)
  bump()
  persistAndEmit()
  return getDownloadStatusSnapshot()
}

export function beginOwnedDownload(input: BeginDownloadInput): BeginDownloadResult {
  const allowed = canStartDownload(view && !view.dismissed ? view : null)
  if (!allowed.ok) {
    return { ok: false, reason: 'already-running', snapshot: getDownloadStatusSnapshot() }
  }
  form = serializeDownloadForm({
    repoId: input.repoId,
    revision: input.revision,
    folderName: input.folderName
  })
  const now = hooks.now()
  sequence = bump()
  view = {
    sequence,
    operationId: input.operationId,
    status: 'running',
    repoId: form.repoId,
    revision: form.revision,
    folderName: input.folderName,
    startedAt: now,
    updatedAt: now,
    downloadedBytes: input.downloadedBytes,
    totalBytes: input.totalBytes,
    percent: input.totalBytes && input.totalBytes > 0 ? 0 : null,
    dismissed: false
  }
  inFlight = {
    operationId: input.operationId,
    folderName: input.folderName,
    bytesDownloaded: input.downloadedBytes,
    bytesTotal: input.totalBytes
  }
  interruptedByBackend = false
  lastProgressLog = {
    loggedAt: now,
    loggedPercent: view.percent,
    loggedBytes: input.downloadedBytes
  }
  speedSample = { bytes: input.downloadedBytes, at: now }
  logLine('start')
  persistAndEmit()
  return { ok: true, snapshot: getDownloadStatusSnapshot() }
}

export function updateDownloadProgress(partial: {
  downloadedBytes: number
  totalBytes: number | null
  percent: number | null
  status?: TabbyDownloadSessionStatus
  error?: string
  folderConflict?: FolderConflictInfo
}): TabbyDownloadStatusSnapshot {
  if (!view) return getDownloadStatusSnapshot()
  const now = hooks.now()
  const speed = computeReliableSpeed({
    prevBytes: speedSample.bytes,
    prevAt: speedSample.at,
    nextBytes: partial.downloadedBytes,
    nextAt: now,
    totalBytes: partial.totalBytes
  })
  if (partial.downloadedBytes !== speedSample.bytes) {
    speedSample = { bytes: partial.downloadedBytes, at: now }
  }
  const nextStatus = partial.status ?? view.status
  view = sanitizeDownloadSessionView({
    ...view,
    sequence: bump(),
    status: nextStatus,
    downloadedBytes: partial.downloadedBytes,
    totalBytes: partial.totalBytes,
    percent: partial.percent,
    updatedAt: now,
    error: partial.error
      ? partial.error
      : nextStatus === 'running'
        ? undefined
        : view.error,
    folderConflict: partial.folderConflict ?? view.folderConflict,
    bytesPerSec: speed.bytesPerSec,
    etaSeconds: speed.etaSeconds
  })
  if (inFlight && nextStatus === 'running') {
    inFlight = {
      ...inFlight,
      bytesDownloaded: partial.downloadedBytes,
      bytesTotal: partial.totalBytes
    }
  }
  if (nextStatus === 'running') {
    if (
      shouldLogProgress(lastProgressLog, {
        now,
        percent: partial.percent,
        bytesDownloaded: partial.downloadedBytes
      })
    ) {
      logLine('progress')
      lastProgressLog = {
        loggedAt: now,
        loggedPercent: partial.percent,
        loggedBytes: partial.downloadedBytes
      }
    }
  } else if (nextStatus === 'success') {
    logLine('complete')
  } else if (nextStatus === 'interrupted') {
    logLine('interrupted')
  } else if (nextStatus === 'error' || nextStatus === 'conflict') {
    logLine('error', { error: partial.error ?? view.error })
  }
  persistAndEmit()
  return getDownloadStatusSnapshot()
}

export function recordDownloadConflict(input: {
  repoId: string
  revision?: string
  folderName: string
  conflict: FolderConflictInfo
  error: string
}): TabbyDownloadStatusSnapshot {
  form = serializeDownloadForm(input)
  const now = hooks.now()
  view = sanitizeDownloadSessionView({
    sequence: bump(),
    operationId: view?.operationId ?? `conflict-${now.toString(36)}`,
    status: 'conflict',
    repoId: form.repoId,
    revision: form.revision,
    folderName: input.folderName,
    startedAt: view?.startedAt ?? now,
    updatedAt: now,
    downloadedBytes: input.conflict.bytesOnDisk,
    totalBytes: input.conflict.expectedBytes,
    percent: null,
    error: input.error,
    folderConflict: input.conflict,
    dismissed: false
  })
  persistAndEmit()
  return getDownloadStatusSnapshot()
}

export function dismissDownloadSession(): TabbyDownloadStatusSnapshot {
  if (!view || view.status === 'running') return getDownloadStatusSnapshot()
  view = { ...view, dismissed: true, sequence: bump() }
  persistAndEmit()
  view = null
  bump()
  persistAndEmit()
  return getDownloadStatusSnapshot()
}

export async function recoverPersistedDownload(opts: {
  modelDir: string
  measureBytes: (resolvedPath: string) => Promise<number>
  listSiblingNames?: (modelDir: string) => Promise<string[]>
}): Promise<TabbyDownloadStatusSnapshot> {
  if (!hooks.persistFile || !existsSync(hooks.persistFile)) {
    return getDownloadStatusSnapshot()
  }
  let raw: string
  try {
    raw = readFileSync(hooks.persistFile, 'utf-8')
  } catch {
    return getDownloadStatusSnapshot()
  }
  const parsed = parsePersistedDownloadFile(raw)
  if (!parsed) {
    form = emptyDownloadForm()
    view = null
    persistAndEmit()
    return getDownloadStatusSnapshot()
  }
  form = parsed.form
  const folder = parsed.session?.folderName || parsed.form.folderName
  const guard = folder
    ? guardedFolderFromPersisted(opts.modelDir, folder)
    : { ok: false as const, reason: 'empty_name' as const }
  let bytesOnDisk = 0
  if (guard.ok) {
    try {
      bytesOnDisk = await opts.measureBytes(guard.resolved)
    } catch {
      bytesOnDisk = parsed.session?.downloadedBytes ?? 0
    }
  } else if (parsed.session?.status === 'running') {
    view = null
    bump()
    persistAndEmit()
    return getDownloadStatusSnapshot()
  }
  const recovered = classifyRecoveredSession({
    now: hooks.now(),
    bytesOnDisk,
    persisted: parsed
  })
  form = recovered.form
  view = recovered.session
  if (view && (view.status === 'interrupted' || view.status === 'error') && guard.ok) {
    let siblingNames = [view.folderName]
    if (opts.listSiblingNames) {
      try {
        siblingNames = await opts.listSiblingNames(opts.modelDir)
      } catch {
        siblingNames = [view.folderName]
      }
    }
    view = {
      ...view,
      folderConflict: describeExistingFolder({
        folderName: view.folderName,
        bytesOnDisk: view.downloadedBytes,
        expectedBytes: view.totalBytes,
        siblingNames
      })
    }
  }
  sequence = Math.max(sequence, view?.sequence ?? 0, 1)
  if (view) view = { ...view, sequence }
  if (recovered.didRestoreIncomplete && view) {
    logLine('restored')
  }
  persistAndEmit()
  return getDownloadStatusSnapshot()
}

export function startDownloadSession(next: DownloadSession): void {
  inFlight = { ...next }
  interruptedByBackend = false
  const now = hooks.now()
  if (view?.operationId === next.operationId) {
    view = {
      ...view,
      folderName: next.folderName,
      downloadedBytes: next.bytesDownloaded,
      totalBytes: next.bytesTotal,
      updatedAt: now,
      sequence: bump()
    }
  } else if (!view) {
    view = {
      sequence: bump(),
      operationId: next.operationId,
      status: 'running',
      repoId: form.repoId,
      revision: form.revision,
      folderName: next.folderName,
      startedAt: now,
      updatedAt: now,
      downloadedBytes: next.bytesDownloaded,
      totalBytes: next.bytesTotal,
      percent: null,
      dismissed: false
    }
  }
}

export function updateDownloadSession(partial: Partial<Omit<DownloadSession, 'operationId'>>): void {
  if (!inFlight) return
  inFlight = { ...inFlight, ...partial }
  if (view && view.status === 'running') {
    view = {
      ...view,
      downloadedBytes: inFlight.bytesDownloaded,
      totalBytes: inFlight.bytesTotal,
      updatedAt: hooks.now()
    }
  }
}

export function finishDownloadSession(): DownloadSession | null {
  const prev = inFlight
  inFlight = null
  interruptedByBackend = false
  return prev
}

export function getDownloadSession(): DownloadSession | null {
  return inFlight
}

/** @returns true when a download was in flight and is now marked interrupted. */
export function noteBackendLost(): boolean {
  if (!inFlight) return false
  interruptedByBackend = true
  return true
}

export function wasDownloadInterruptedByBackend(): boolean {
  return interruptedByBackend
}

export function resetDownloadSessionForTests(opts?: {
  persistFile?: string | null
  now?: () => number
  log?: StoreHooks['log']
  emit?: StoreHooks['emit']
}): void {
  inFlight = null
  interruptedByBackend = false
  sequence = 0
  form = emptyDownloadForm()
  view = null
  lastProgressLog = { loggedAt: 0, loggedPercent: null, loggedBytes: 0 }
  speedSample = { bytes: 0, at: 0 }
  hooks = {
    persistFile: opts?.persistFile ?? null,
    now: opts?.now ?? (() => Date.now()),
    log: opts?.log ?? (() => {}),
    emit: opts?.emit ?? (() => {})
  }
}

/** Test helper: apply an incoming snapshot using the same reducer as the renderer. */
export function reduceDownloadStatus(
  current: TabbyDownloadStatusSnapshot | null,
  incoming: TabbyDownloadStatusSnapshot
): TabbyDownloadStatusSnapshot {
  return applyDownloadStatusUpdate(current, incoming)
}
