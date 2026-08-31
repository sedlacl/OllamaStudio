/** Lokální velikost a kompletnost Tabby modelů na disku (cache + validace). */

import { open, readFile } from 'fs/promises'
import { lstat, readdir, realpath, stat } from 'fs/promises'
import { join, resolve } from 'path'
import type { ModelSummary } from '../backends/types'
import { isPathStrictlyInside, resolveSafeModelSubdir } from './hf-download-helpers'
import type { TabbyDownloadStatusSnapshot } from './download-session-helpers'

export type LocalModelCompleteness = 'complete' | 'incomplete' | 'unknown'
export type LocalModelSizeState = 'known' | 'unknown' | 'error'

export interface LocalModelInfo {
  sizeBytes: number | null
  sizeState: LocalModelSizeState
  completeness: LocalModelCompleteness
}

interface CacheEntry {
  info: LocalModelInfo
  cachedAt: number
  fingerprint: string
}

const CACHE_TTL_MS = 30_000
const SCAN_CONCURRENCY = 4
const MAX_SAFETENSORS_HEADER = 100 * 1024 * 1024

const cache = new Map<string, CacheEntry>()
let cacheGeneration = 0

type SafetensorsCheck = 'valid' | 'truncated' | 'unreadable'

export function resetLocalModelCacheForTests(): void {
  cache.clear()
  cacheGeneration = 0
}

export function invalidateLocalModelCache(folderName?: string): void {
  cacheGeneration += 1
  if (!folderName) {
    cache.clear()
    return
  }
  const keyPrefix = `${folderName}\0`
  for (const key of cache.keys()) {
    if (key.startsWith(keyPrefix)) cache.delete(key)
  }
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

async function resolveGuardedModelDir(
  modelDir: string,
  folderName: string
): Promise<{ ok: true; allowedRoot: string; targetDir: string; folderName: string } | { ok: false }> {
  const lexical = resolveSafeModelSubdir(modelDir, folderName)
  if (!lexical.ok) return { ok: false }

  let allowedRoot = resolve(modelDir)
  try {
    if (await pathExists(modelDir)) {
      allowedRoot = await realpath(modelDir)
    }
  } catch {
    return { ok: false }
  }

  const guarded = resolveSafeModelSubdir(allowedRoot, lexical.folderName)
  if (!guarded.ok) return { ok: false }
  if (!isPathStrictlyInside(allowedRoot, guarded.resolved)) return { ok: false }

  return {
    ok: true,
    allowedRoot,
    targetDir: guarded.resolved,
    folderName: guarded.folderName
  }
}

async function guardedEntryPath(
  allowedRoot: string,
  currentDir: string,
  name: string
): Promise<string | null> {
  if (!name || name === '.' || name === '..' || name.includes('..') || /[/\\]/.test(name)) {
    return null
  }
  const full = join(currentDir, name)
  if (!isPathStrictlyInside(allowedRoot, full)) return null
  return full
}

export function expectedSafetensorsFileSize(
  headerSize: number,
  header: Record<string, unknown>
): number | null {
  let maxEnd = 0
  for (const [key, value] of Object.entries(header)) {
    if (key === '__metadata__') continue
    if (!value || typeof value !== 'object') continue
    const offsets = (value as { data_offsets?: unknown }).data_offsets
    if (!Array.isArray(offsets) || offsets.length < 2) continue
    const end = offsets[1]
    if (typeof end === 'number' && Number.isFinite(end) && end > maxEnd) maxEnd = end
  }
  if (maxEnd <= 0) return null
  return 8 + headerSize + maxEnd
}

export async function checkSafetensorsFile(
  filePath: string,
  fileSize: number
): Promise<SafetensorsCheck> {
  if (fileSize < 8) return 'truncated'

  let handle
  try {
    handle = await open(filePath, 'r')
    const lenBuf = Buffer.alloc(8)
    const { bytesRead } = await handle.read(lenBuf, 0, 8, 0)
    if (bytesRead < 8) return 'truncated'
    const headerSize = Number(lenBuf.readBigUInt64LE(0))
    if (!Number.isFinite(headerSize) || headerSize <= 0 || headerSize > MAX_SAFETENSORS_HEADER) {
      return 'unreadable'
    }
    if (8 + headerSize > fileSize) return 'truncated'

    const headerBuf = Buffer.alloc(headerSize)
    const headerRead = await handle.read(headerBuf, 0, headerSize, 8)
    if (headerRead.bytesRead < headerSize) return 'truncated'
    const parsed = JSON.parse(headerBuf.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable'
    const expected = expectedSafetensorsFileSize(headerSize, parsed as Record<string, unknown>)
    if (expected == null) return 'unreadable'
    if (fileSize < expected) return 'truncated'
    return 'valid'
  } catch {
    return 'unreadable'
  } finally {
    await handle?.close().catch(() => {})
  }
}

interface ScanResult {
  totalBytes: number
  hadAccessibleFile: boolean
  hadInaccessibleFile: boolean
  hasPartFile: boolean
  hasConfig: boolean
  safetensorsFiles: string[]
  indexShards: string[] | null
}

async function scanModelDirectory(allowedRoot: string, targetDir: string): Promise<ScanResult> {
  const result: ScanResult = {
    totalBytes: 0,
    hadAccessibleFile: false,
    hadInaccessibleFile: false,
    hasPartFile: false,
    hasConfig: false,
    safetensorsFiles: [],
    indexShards: null
  }

  const walk = async (current: string): Promise<void> => {
    if (!isPathStrictlyInside(allowedRoot, current)) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      result.hadInaccessibleFile = true
      return
    }

    for (const entry of entries) {
      const full = await guardedEntryPath(allowedRoot, current, entry.name)
      if (!full) continue

      let st
      try {
        st = await lstat(full)
      } catch {
        result.hadInaccessibleFile = true
        continue
      }

      if (st.isSymbolicLink()) {
        result.hadInaccessibleFile = true
        continue
      }

      if (st.isDirectory()) {
        await walk(full)
        continue
      }

      if (!st.isFile()) continue

      try {
        const info = await stat(full)
        result.totalBytes += info.size
        result.hadAccessibleFile = true
      } catch {
        result.hadInaccessibleFile = true
        continue
      }

      const lower = entry.name.toLowerCase()
      if (lower.endsWith('.part')) {
        result.hasPartFile = true
      }
      if (lower === 'config.json' || lower === 'tabby_config.yml') {
        result.hasConfig = true
      }
      if (lower.endsWith('.safetensors') && !lower.endsWith('.safetensors.part')) {
        result.safetensorsFiles.push(full)
      }
    }
  }

  await walk(targetDir)

  const indexPath = join(targetDir, 'model.safetensors.index.json')
  if (await pathExists(indexPath)) {
    try {
      const raw = await readFile(indexPath, 'utf8')
      const parsed = JSON.parse(raw) as { weight_map?: unknown }
      const weightMap = parsed.weight_map
      if (weightMap && typeof weightMap === 'object' && !Array.isArray(weightMap)) {
        const shards = new Set<string>()
        for (const shard of Object.values(weightMap as Record<string, unknown>)) {
          if (typeof shard === 'string' && shard.trim()) shards.add(shard.trim())
        }
        result.indexShards = [...shards]
      }
    } catch {
      result.indexShards = []
    }
  }

  return result
}

export function classifyLocalModelFromScan(scan: ScanResult, safetensorChecks: SafetensorsCheck[]): LocalModelInfo {
  const sizeState: LocalModelSizeState = scan.hadAccessibleFile
    ? scan.hadInaccessibleFile
      ? 'error'
      : 'known'
    : scan.hadInaccessibleFile
      ? 'unknown'
      : 'known'

  const sizeBytes =
    sizeState === 'unknown'
      ? null
      : scan.hadAccessibleFile || !scan.hadInaccessibleFile
        ? scan.totalBytes
        : null

  if (scan.hasPartFile) {
    return { sizeBytes, sizeState, completeness: 'incomplete' }
  }

  if (!scan.hasConfig) {
    return { sizeBytes, sizeState, completeness: 'incomplete' }
  }

  if (scan.safetensorsFiles.length === 0) {
    return { sizeBytes, sizeState, completeness: 'incomplete' }
  }

  if (scan.indexShards != null) {
    if (scan.indexShards.length === 0) {
      return { sizeBytes, sizeState, completeness: 'unknown' }
    }
    const names = new Set(
      scan.safetensorsFiles.map((p) => p.split(/[/\\]/).pop()?.toLowerCase() ?? '')
    )
    for (const shard of scan.indexShards) {
      if (!names.has(shard.toLowerCase())) {
        return { sizeBytes, sizeState, completeness: 'incomplete' }
      }
    }
  }

  if (safetensorChecks.some((c) => c === 'truncated' || c === 'unreadable')) {
    return { sizeBytes, sizeState, completeness: 'incomplete' }
  }
  if (safetensorChecks.length === 0) {
    return { sizeBytes, sizeState, completeness: 'unknown' }
  }
  if (safetensorChecks.every((c) => c === 'valid')) {
    return { sizeBytes, sizeState, completeness: 'complete' }
  }
  return { sizeBytes, sizeState, completeness: 'unknown' }
}

async function dirFingerprint(targetDir: string): Promise<string> {
  try {
    const st = await stat(targetDir)
    return `${st.mtimeMs}:${cacheGeneration}`
  } catch {
    return `missing:${cacheGeneration}`
  }
}

export async function inspectLocalModel(modelDir: string, folderName: string): Promise<LocalModelInfo> {
  const guarded = await resolveGuardedModelDir(modelDir, folderName)
  if (!guarded.ok) {
    return { sizeBytes: null, sizeState: 'unknown', completeness: 'unknown' }
  }

  if (!(await pathExists(guarded.targetDir))) {
    return { sizeBytes: null, sizeState: 'unknown', completeness: 'unknown' }
  }

  const cacheKey = `${guarded.folderName}\0${guarded.targetDir}`
  const fingerprint = await dirFingerprint(guarded.targetDir)
  const cached = cache.get(cacheKey)
  const now = Date.now()
  if (cached && cached.fingerprint === fingerprint && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.info
  }

  const scan = await scanModelDirectory(guarded.allowedRoot, guarded.targetDir)
  const safetensorChecks: SafetensorsCheck[] = []
  for (const filePath of scan.safetensorsFiles) {
    let fileSize = 0
    try {
      fileSize = (await stat(filePath)).size
    } catch {
      safetensorChecks.push('unreadable')
      continue
    }
    safetensorChecks.push(await checkSafetensorsFile(filePath, fileSize))
  }

  const info = classifyLocalModelFromScan(scan, safetensorChecks)
  cache.set(cacheKey, { info, cachedAt: now, fingerprint })
  return info
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const results: R[] = new Array(items.length)
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = index
      index += 1
      if (i >= items.length) break
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

function activeDownloadForFolder(
  snapshot: TabbyDownloadStatusSnapshot | undefined,
  folderName: string
): { downloadedBytes: number; totalBytes: number | null } | null {
  const session = snapshot?.session
  if (!session || session.dismissed) return null
  if (session.folderName !== folderName) return null
  if (session.status !== 'running') return null
  return {
    downloadedBytes: session.downloadedBytes,
    totalBytes: session.totalBytes
  }
}

export async function enrichTabbyModelSummaries(
  models: ModelSummary[],
  modelDir: string,
  downloadSnapshot?: TabbyDownloadStatusSnapshot
): Promise<ModelSummary[]> {
  return mapWithConcurrency(models, SCAN_CONCURRENCY, async (model) => {
    const active = activeDownloadForFolder(downloadSnapshot, model.modelId)
    if (active) {
      return {
        ...model,
        sizeBytes: active.downloadedBytes,
        localCompleteness: 'incomplete' as const
      }
    }

    const local = await inspectLocalModel(modelDir, model.modelId)
    return {
      ...model,
      sizeBytes: local.sizeState === 'known' ? local.sizeBytes : null,
      localCompleteness: local.completeness
    }
  })
}
