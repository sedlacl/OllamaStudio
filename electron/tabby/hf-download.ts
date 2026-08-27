import { existsSync } from 'fs'
import { lstat, readdir, realpath, rmdir, unlink } from 'fs/promises'
import { isAbsolute, join, resolve } from 'path'
import { tMain } from '../i18n'
import type { TabbyDownloadRequest } from './client'
import {
  calculateDownloadProgress,
  completeDownloadProgress,
  describeExistingFolder,
  HfApiError,
  isPathStrictlyInside,
  parseTabbyFolderExistsError,
  redactSecrets,
  resolveDownloadFolderName,
  resolveSafeModelSubdir,
  type DownloadProgressSample,
  type FolderConflictInfo
} from './hf-download-helpers'
import { directoryByteSize, fetchHfExpectedBytes } from './hf-hub'

export type TabbyDownloadProgressStatus = 'running' | 'success' | 'error'
export type TabbyDownloadFolderConflict = FolderConflictInfo

export interface TabbyDownloadProgressEvent {
  operationId: string
  status: TabbyDownloadProgressStatus
  message?: string
  percent?: number | null
  bytesDownloaded?: number
  bytesTotal?: number | null
}

export interface TabbyDownloadResult {
  ok: boolean
  downloadPath?: string
  error?: string
  folderConflict?: TabbyDownloadFolderConflict
}

const POLL_MS = 1000
const DELETE_ATTEMPTS = 5

export function hfErrorToMessage(err: unknown): string {
  if (err instanceof HfApiError) {
    switch (err.code) {
      case 'unauthorized':
        return tMain('errors.hfUnauthorized')
      case 'forbidden':
        return tMain('errors.hfForbidden')
      case 'not_found':
        return tMain('errors.hfNotFound')
      case 'rate_limited':
        return tMain('errors.hfRateLimited')
      case 'invalid_json':
        return tMain('errors.hfInvalidResponse')
      case 'network':
        return tMain('errors.hfNetwork')
      case 'http_error':
        return tMain('errors.hfHttpError', { status: err.status ?? 0 })
    }
  }
  const raw = redactSecrets(err instanceof Error ? err.message : String(err))
  const existingFolder = parseTabbyFolderExistsError(raw)
  if (existingFolder) {
    return tMain('errors.hfFolderExists', { folder: existingFolder })
  }
  return raw
}

function isBusyErrno(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function raceWithTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer != null) clearTimeout(timer)
  })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/**
 * Maže jen lexikální strom pod `allowedRoot`. Symlinky a junctions se odpojí
 * (unlink), nikdy se do nich nevstupuje — Tabby `/v1/download` resume nepodporuje.
 */
async function rmTreeUnfollowing(allowedRoot: string, current: string): Promise<void> {
  if (!isPathStrictlyInside(allowedRoot, current)) {
    throw new Error('unsafe-delete-path')
  }
  let st
  try {
    st = await lstat(current)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  if (st.isSymbolicLink()) {
    await unlink(current)
    return
  }
  if (st.isDirectory()) {
    const entries = await readdir(current)
    for (const name of entries) {
      if (!name || name === '.' || name === '..' || name.includes('..') || /[/\\]/.test(name)) {
        continue
      }
      await rmTreeUnfollowing(allowedRoot, join(current, name))
    }
    await rmdir(current)
    return
  }
  await unlink(current)
}

export async function inspectTabbyDownloadTarget(opts: {
  modelDir: string
  repoId: string
  revision?: string
  folderName?: string
  token?: string
}): Promise<{ folderName: string; conflict: TabbyDownloadFolderConflict | null }> {
  const folderName = resolveDownloadFolderName(opts.repoId, opts.revision, opts.folderName)
  const guard = resolveSafeModelSubdir(opts.modelDir, folderName)
  const targetDir = guard.ok ? guard.resolved : join(opts.modelDir, folderName)

  if (!(await pathExists(targetDir))) {
    return { folderName, conflict: null }
  }

  let bytesOnDisk = 0
  try {
    bytesOnDisk = await directoryByteSize(targetDir)
  } catch {
    bytesOnDisk = 0
  }

  let expectedBytes: number | null = null
  try {
    expectedBytes = await raceWithTimeout(
      fetchHfExpectedBytes(opts.repoId, opts.revision, opts.token),
      8_000,
      null
    )
  } catch {
    expectedBytes = null
  }

  let siblingNames: string[] = [folderName]
  try {
    siblingNames = await readdir(opts.modelDir)
  } catch {
    siblingNames = [folderName]
  }

  return {
    folderName,
    conflict: describeExistingFolder({
      folderName,
      bytesOnDisk,
      expectedBytes,
      siblingNames
    })
  }
}

export async function deleteTabbyDownloadFolder(
  modelDir: string,
  folderName: string
): Promise<{ ok: boolean; error?: string }> {
  const lexical = resolveSafeModelSubdir(modelDir, folderName)
  if (!lexical.ok) {
    return { ok: false, error: tMain('errors.hfDeleteUnsafe') }
  }

  let allowedRoot = resolve(modelDir)
  try {
    if (await pathExists(modelDir)) {
      allowedRoot = await realpath(modelDir)
    }
  } catch {
    return { ok: false, error: tMain('errors.hfDeleteUnsafe') }
  }

  const guarded = resolveSafeModelSubdir(allowedRoot, lexical.folderName)
  if (!guarded.ok) {
    return { ok: false, error: tMain('errors.hfDeleteUnsafe') }
  }

  const target = guarded.resolved
  if (!isPathStrictlyInside(allowedRoot, target)) {
    return { ok: false, error: tMain('errors.hfDeleteUnsafe') }
  }

  if (!(await pathExists(target))) {
    return { ok: true }
  }

  let lastErr: unknown
  for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt++) {
    try {
      if (!(await pathExists(target))) return { ok: true }
      const st = await lstat(target)
      if (st.isSymbolicLink() || st.isFile()) {
        await unlink(target)
      } else {
        await rmTreeUnfollowing(allowedRoot, target)
      }
      if (!(await pathExists(target))) return { ok: true }
      lastErr = new Error('EBUSY')
    } catch (err) {
      lastErr = err
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true }
      if (!isBusyErrno(err) && (err as Error).message !== 'unsafe-delete-path') {
        return { ok: false, error: redactSecrets(tMain('errors.hfDeleteFailed')) }
      }
      if ((err as Error).message === 'unsafe-delete-path') {
        return { ok: false, error: tMain('errors.hfDeleteUnsafe') }
      }
    }
    await sleep(150 * (attempt + 1))
  }

  if (isBusyErrno(lastErr)) {
    return { ok: false, error: tMain('errors.hfDeleteBusy') }
  }
  return { ok: false, error: tMain('errors.hfDeleteFailed') }
}

function verifiedDownloadPath(
  returned: string | undefined,
  modelDir: string,
  folderName: string
): string | null {
  const candidates: string[] = []
  const trimmed = returned?.trim()
  if (trimmed) {
    candidates.push(isAbsolute(trimmed) ? trimmed : resolve(modelDir, trimmed))
  }
  candidates.push(join(modelDir, folderName))
  for (const path of candidates) {
    if (path && existsSync(path)) return path
  }
  return null
}

export async function runTabbyHfDownload(opts: {
  req: TabbyDownloadRequest
  operationId: string
  modelDir: string
  emit: (event: TabbyDownloadProgressEvent) => void
  download: (req: TabbyDownloadRequest) => Promise<{ downloadPath: string }>
}): Promise<TabbyDownloadResult> {
  const repoId = opts.req.repoId?.trim() ?? ''
  if (!repoId) {
    return { ok: false, error: tMain('errors.hfRepoIdEmpty') }
  }

  const revision = opts.req.revision?.trim() || undefined
  const folderName = resolveDownloadFolderName(repoId, revision, opts.req.folderName)
  const targetDir = join(opts.modelDir, folderName)
  const token = opts.req.token?.trim() || undefined

  const inspected = await inspectTabbyDownloadTarget({
    modelDir: opts.modelDir,
    repoId,
    revision,
    folderName,
    token
  })
  if (inspected.conflict) {
    // TabbyAPI POST /v1/download nemá resume a existující cestu odmítne HTTP 400.
    return {
      ok: false,
      folderConflict: inspected.conflict,
      error: tMain('errors.hfFolderExists', { folder: inspected.conflict.folderName })
    }
  }

  const emit = (partial: Omit<TabbyDownloadProgressEvent, 'operationId'>): void => {
    try {
      opts.emit({ operationId: opts.operationId, ...partial })
    } catch {
      /* renderer mohl zmizet */
    }
  }

  let bytesTotal: number | null = null
  try {
    bytesTotal = await fetchHfExpectedBytes(repoId, revision, token)
  } catch {
    bytesTotal = null
  }

  let baseline = 0
  try {
    baseline = await directoryByteSize(targetDir)
  } catch {
    baseline = 0
  }

  let maxBytes = baseline
  let percent: number | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let cancelled = false

  const sample = async (): Promise<DownloadProgressSample> => {
    let onDisk = baseline
    try {
      onDisk = await directoryByteSize(targetDir)
    } catch {
      /* složku nelze číst → držíme poslední známou hodnotu */
    }
    const next = calculateDownloadProgress({
      bytesOnDisk: onDisk,
      bytesTotal,
      baseline,
      previousMaxBytes: maxBytes,
      previousPercent: percent
    })
    maxBytes = next.bytesDownloaded
    percent = next.percent
    return next
  }

  const pushRunning = (progress: DownloadProgressSample): void => {
    emit({
      status: 'running',
      percent: progress.percent,
      bytesDownloaded: progress.bytesDownloaded,
      bytesTotal: progress.bytesTotal
    })
  }

  try {
    const initial = calculateDownloadProgress({
      bytesOnDisk: baseline,
      bytesTotal,
      baseline,
      previousMaxBytes: baseline,
      previousPercent: null
    })
    maxBytes = initial.bytesDownloaded
    percent = initial.percent
    pushRunning(initial)

    pollTimer = setInterval(() => {
      if (cancelled) return
      void sample().then((progress) => {
        if (!cancelled) pushRunning(progress)
      })
    }, POLL_MS)

    const result = await opts.download({
      repoId,
      revision,
      folderName,
      token
    })

    const verified = verifiedDownloadPath(result.downloadPath, opts.modelDir, folderName)
    if (!verified) {
      const error = tMain('errors.hfDownloadPathMissing')
      emit({ status: 'error', message: error, percent, bytesDownloaded: maxBytes, bytesTotal })
      return { ok: false, error }
    }

    const last = await sample()
    const done = completeDownloadProgress({
      bytesDownloaded: last.bytesDownloaded,
      bytesTotal: last.bytesTotal
    })
    emit({
      status: 'success',
      message: verified,
      percent: done.percent,
      bytesDownloaded: done.bytesDownloaded,
      bytesTotal: done.bytesTotal
    })
    return { ok: true, downloadPath: verified }
  } catch (err) {
    const error = hfErrorToMessage(err)
    emit({
      status: 'error',
      message: error,
      percent,
      bytesDownloaded: maxBytes,
      bytesTotal
    })
    return { ok: false, error }
  } finally {
    cancelled = true
    if (pollTimer != null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
}
