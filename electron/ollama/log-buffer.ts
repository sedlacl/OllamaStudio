import { parseTabbyLogLine } from '../tabby/log-parser'

export type LogLevel = 'info' | 'error' | 'warn' | 'debug'

export type LogCategory = 'general' | 'error' | 'load' | 'unload' | 'request'

export type ActiveRequestPhase =
  | 'prompt_processing'
  | 'generation'
  | 'caching'
  | 'done'
  | 'unknown'

/** Outcome retained in request history (never invent success for stale tasks). */
export type RequestHistoryResult = 'done' | 'stale' | 'error'

/** Runner API surface, or an app-managed action such as model load. */
export type RequestKind = 'chat' | 'generate' | 'embed' | 'load'

export interface ParsedLogEvent {
  durationMs?: number
  promptTokensPerSec?: number
  generationTokensPerSec?: number
  isLoad?: boolean
  isUnload?: boolean
  isError?: boolean
  isRequest?: boolean
  slotId?: number
  taskId?: number
  phase?: ActiveRequestPhase
  nTokens?: number
  /** Which token counter the nTokens value represents, when known. */
  tokenKind?: 'prompt' | 'generation'
  progress?: number
  elapsedSeconds?: number
  tokensPerSec?: number
  isSlotActivity?: boolean
  isTaskComplete?: boolean
  completionReason?: string
  /** Runner request line preceding the slot launch; carries no task id yet. */
  requestKind?: RequestKind
  /** API route line logged after the response finished. */
  routeKind?: RequestKind
}

export interface ActiveRequest {
  taskId: number
  slotId: number | null
  /** chat/generate/embed from runner logs, or load from the app. */
  kind: RequestKind | null
  /** Model name when known (app-managed load). */
  model: string | null
  phase: ActiveRequestPhase
  /** 0–100 when known from logs; null when absent (do not invent). */
  progressPercent: number | null
  nTokens: number | null
  promptTokens: number | null
  generationTokens: number | null
  elapsedSeconds: number | null
  tokensPerSec: number | null
  promptTokensPerSec: number | null
  generationTokensPerSec: number | null
  firstSeenAt: number
  updatedAt: number
  status: 'active' | 'completed'
  completionReason: string | null
  /** App-initiated (model load); not derived from runner slot logs. */
  managed?: boolean
}

/** Completed/stale task snapshot for dashboard history (max 10, newest first). */
export interface RequestHistoryItem {
  taskId: number
  slotId: number | null
  kind: RequestKind | null
  model: string | null
  phase: ActiveRequestPhase | null
  result: RequestHistoryResult
  completionReason: string | null
  progressPercent: number | null
  promptTokens: number | null
  generationTokens: number | null
  elapsedSeconds: number | null
  promptTokensPerSec: number | null
  generationTokensPerSec: number | null
  startedAt: number
  completedAt: number
}

const MAX_ENTRIES = 5000
const MAX_HISTORY = 10
/** Keep completed tasks briefly so the UI can show a short done state. */
const COMPLETED_RETENTION_MS = 8_000
/** Drop tasks with no log updates (stale/aborted). */
const STALE_ACTIVE_MS = 90_000
/** Runner logs the request kind just before launching the slot; ignore older hints. */
const REQUEST_KIND_MAX_AGE_MS = 60_000

const LOAD_RE = /load(?:ing|ed)?\s+(?:model|weights)?/i
const UNLOAD_RE = /unload(?:ing|ed)?/i
const ERROR_RE = /error|fatal|panic|failed/i
/** Ollama structured logs: `level=DEBUG`, `level=INFO`, … */
const EXPLICIT_LEVEL_RE = /\blevel=(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/i
/** Prefer API routes; bare "request/chat/generate" pollutes DEBUG noise. */
const REQUEST_RE = /(?:POST|GET)\s+\/api\/(?:chat|generate|embed|pull)\b/i
const DURATION_RE = /duration[=:\s]+([\d.]+)\s*(ms|s)?/i
const PROMPT_TPS_RE = /prompt\s+eval\s+(?:rate|tok\/s)[=:\s]+([\d.]+)/i
const GEN_TPS_RE = /(?:generation|eval)\s+(?:rate|tok\/s)[=:\s]+([\d.]+)/i
const ALT_TPS_RE = /([\d.]+)\s+tok(?:en)?s?\/s/i

/**
 * Ollama/llama runner: `slot print_timing: id 0 | task 21928 | ...`
 * Captures signed task ids so `task -1` can be ignored explicitly.
 */
const SLOT_HEADER_RE = /\bslot\b[^\n]*?\bid\s+(\d+)\s*\|\s*task\s+(-?\d+)\s*\|/i
const SLOT_PROGRESS_RE = /progress\s*=\s*([\d.]+)/i
const SLOT_N_TOKENS_RE = /(?:cached\s+)?n_tokens\s*=\s*(\d+)/i
const SLOT_N_DECODED_RE = /\bn_decoded\s*=\s*(\d+)/i
const SLOT_ELAPSED_RE = /\bt\s*=\s*([\d.]+)\s*s\b/i
const SLOT_TPS_RE = /([\d.]+)\s+tokens?\s+per\s+second/i
/** Live decode throughput: `tg = 5.57 t/s` */
const SLOT_TG_TPS_RE = /\btg\s*=\s*([\d.]+)\s*t\/s/i
/**
 * Když llama.cpp naměří 0.00 ms, vytiskne místo dělení nulou 1000000.00 tokens per second.
 * Taková hodnota by se jinak dostala do klouzavého průměru na Přehledu i vedle řádku logu.
 */
const MAX_PLAUSIBLE_TPS = 50_000

function parseTps(raw: string): number | null {
  const value = parseFloat(raw)
  if (!Number.isFinite(value) || value <= 0 || value > MAX_PLAUSIBLE_TPS) return null
  return value
}
/** Prompt/eval summary token count: `ms / 290 tokens` */
const SLOT_SUMMARY_TOKENS_RE = /\/\s*(\d+)\s+tokens\b/i
/**
 * Reliable completion only — avoid broad words like "finished/complete"
 * that appear in unrelated runner/debug text on the same line family.
 */
const SLOT_DONE_RE =
  /\bslot\s+release\b|\bstop(?:ped)?\s+processing\b|\bdone processing\b/i
/** `msg="llama-server chat request"`, `… completion request`, `… embedding request` */
const REQUEST_KIND_RE = /llama-server\s+(chat|completion|embedding|embed)\s+request/i
/** llama-server logs this for chat requests even when Ollama DEBUG is off. */
const CHAT_FORMAT_RE = /\bchat\s+format\s*:/i
/**
 * Route line `POST "/api/chat"` is logged after the response finishes, so it can
 * only backfill a task whose kind was never seen (e.g. Ollama DEBUG disabled).
 */
const REQUEST_ROUTE_RE = /POST\s+"?\/api\/(chat|generate|embed(?:dings)?)\b/i
/** Route hint applies only to a task that just finished. */
const ROUTE_HINT_MAX_AGE_MS = 10_000

export interface LogEntry {
  id: number
  timestamp: number
  stream: 'stdout' | 'stderr'
  text: string
  level: LogLevel
  category: LogCategory
  parsed?: ParsedLogEvent
}

export interface LogBufferOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => number
  maxHistory?: number
}

export type LogVendor = 'ollama' | 'tabby'

export class LogBuffer {
  private entries: LogEntry[] = []
  private nextId = 1
  private listeners = new Set<(entry: LogEntry) => void>()
  private fileStream: { write: (s: string) => void } | null = null
  private recentGenTps: number[] = []
  private activeRequestEstimate = 0
  private activeRequests = new Map<number, ActiveRequest>()
  private requestHistory: RequestHistoryItem[] = []
  /** Last runner request kind seen, waiting for the slot launch that follows it. */
  private pendingRequestKind: { kind: RequestKind; at: number } | null = null
  /** Negative ids so they never collide with Ollama runner task ids (or task -1). */
  private nextManagedTaskId = -2
  private vendor: LogVendor = 'ollama'
  private tabbyRequestIds = new Map<string, number>()
  private readonly nowFn: () => number
  private readonly maxHistory: number

  constructor(options?: LogBufferOptions) {
    this.nowFn = options?.now ?? (() => Date.now())
    this.maxHistory = options?.maxHistory ?? MAX_HISTORY
  }

  setVendor(vendor: LogVendor): void {
    if (this.vendor === vendor) return
    this.vendor = vendor
    this.clear()
  }

  getVendor(): LogVendor {
    return this.vendor
  }

  private now(): number {
    return this.nowFn()
  }

  setFileWriter(writer: { write: (s: string) => void } | null): void {
    this.fileStream = writer
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * App-originated line (IPC / HF failures). Does not run Ollama or Tabby
   * parsers, so it cannot invent slot/request metrics.
   */
  appendApp(level: LogLevel, text: string): void {
    const line = text.replace(/\r?\n/g, ' ').trim()
    if (!line) return
    const entry: LogEntry = {
      id: this.nextId++,
      timestamp: this.now(),
      stream: 'stderr',
      text: line,
      level,
      category: level === 'error' || level === 'warn' ? 'error' : 'general',
      parsed: { isError: level === 'error' }
    }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    }
    if (this.fileStream) {
      const ts = new Date(entry.timestamp).toISOString()
      this.fileStream.write(`[${ts}] [studio] ${line}\n`)
    }
    for (const listener of this.listeners) {
      listener(entry)
    }
  }

  append(stream: 'stdout' | 'stderr', text: string): void {
    const lines = text.split(/\r?\n/)
    for (const line of lines) {
      if (line.length === 0) continue
      const entry = this.createEntry(stream, line)
      this.entries.push(entry)
      if (this.entries.length > MAX_ENTRIES) {
        this.entries.splice(0, this.entries.length - MAX_ENTRIES)
      }
      this.updateMetrics(entry)
      if (this.fileStream) {
        const ts = new Date(entry.timestamp).toISOString()
        this.fileStream.write(`[${ts}] [${stream}] ${line}\n`)
      }
      for (const listener of this.listeners) {
        listener(entry)
      }
    }
  }

  getEntries(limit = 500): LogEntry[] {
    return this.entries.slice(-limit)
  }

  getRollingTokensPerSec(): number | null {
    if (this.recentGenTps.length === 0) return null
    const sum = this.recentGenTps.reduce((a, b) => a + b, 0)
    return sum / this.recentGenTps.length
  }

  getActiveRequestEstimate(): number | null {
    this.syncActiveRequestsFromEntries()
    const live = [...this.activeRequests.values()].filter((r) => r.status === 'active').length
    // Slot-based live count only — legacy REQUEST_RE estimate was noisy (DEBUG "request").
    if (live > 0) return live
    return this.activeRequestEstimate > 0 ? this.activeRequestEstimate : null
  }

  getActiveRequests(): ActiveRequest[] {
    this.syncActiveRequestsFromEntries()
    const now = this.now()
    for (const req of this.activeRequests.values()) {
      if (req.managed && req.status === 'active') {
        req.elapsedSeconds = (now - req.firstSeenAt) / 1000
      }
    }
    return [...this.activeRequests.values()].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
  }

  /**
   * Newest-first completed/stale snapshots (max 10).
   * Does not run active-map sync/prune — history must not depend on live grace.
   */
  getRequestHistory(): RequestHistoryItem[] {
    return this.requestHistory.slice()
  }

  clear(): void {
    this.entries = []
    this.recentGenTps = []
    this.activeRequestEstimate = 0
    this.activeRequests.clear()
    this.requestHistory = []
    this.pendingRequestKind = null
    this.nextManagedTaskId = -2
    this.tabbyRequestIds.clear()
  }

  private createEntry(stream: 'stdout' | 'stderr', line: string): LogEntry {
    const parsed =
      this.vendor === 'tabby' ? this.parseTabbyLine(line) : parseLine(line)
    const explicitLevel = parseExplicitLevel(line)
    // Runner slot lines arrive on stderr without level=; they are not errors.
    const stderrIsError =
      this.vendor !== 'tabby' &&
      stream === 'stderr' &&
      explicitLevel !== 'debug' &&
      explicitLevel !== 'info' &&
      !parsed.isSlotActivity

    let category: LogCategory = 'general'
    if (parsed.isError && explicitLevel !== 'debug' && explicitLevel !== 'info') {
      category = 'error'
    } else if (stderrIsError) {
      category = 'error'
    } else if (parsed.isLoad) {
      category = 'load'
    } else if (parsed.isUnload) {
      category = 'unload'
    } else if (parsed.isRequest || parsed.isSlotActivity) {
      category = 'request'
    }

    const level: LogLevel =
      explicitLevel ??
      (parsed.isSlotActivity
        ? 'info'
        : category === 'error'
          ? 'error'
          : stream === 'stderr' && this.vendor !== 'tabby'
            ? 'warn'
            : 'info')

    return {
      id: this.nextId++,
      timestamp: this.now(),
      stream,
      text: line,
      level,
      category,
      parsed
    }
  }

  private parseTabbyLine(line: string): ParsedLogEvent {
    const t = parseTabbyLogLine(line)
    return {
      isLoad: t.isLoad,
      isUnload: t.isUnload,
      isError: t.isError,
      isRequest: t.isRequest,
      isTaskComplete: t.isComplete,
      generationTokensPerSec: t.generationTokensPerSec,
      promptTokensPerSec: t.promptTokensPerSec,
      elapsedSeconds: t.elapsedSeconds,
      nTokens: t.generationTokens,
      tokenKind: t.generationTokens != null ? 'generation' : undefined,
      taskId: t.requestId ? this.tabbyTaskId(t.requestId) : undefined
    }
  }

  private tabbyTaskId(requestId: string): number {
    const existing = this.tabbyRequestIds.get(requestId)
    if (existing != null) return existing
    const id = this.nextManagedTaskId
    this.nextManagedTaskId -= 1
    this.tabbyRequestIds.set(requestId, id)
    return id
  }

  private updateMetrics(entry: LogEntry): void {
    if (entry.parsed?.generationTokensPerSec) {
      this.recentGenTps.push(entry.parsed.generationTokensPerSec)
      if (this.recentGenTps.length > 20) this.recentGenTps.shift()
    }
    if (entry.parsed?.isRequest && !entry.parsed.isSlotActivity) {
      this.activeRequestEstimate = Math.min(this.activeRequestEstimate + 1, 99)
    }
    if (entry.parsed?.durationMs !== undefined) {
      this.activeRequestEstimate = Math.max(0, this.activeRequestEstimate - 1)
    }
    this.updateActiveRequests(entry)
  }

  /**
   * Rebuild live task map from recent buffer entries so dashboard stays correct
   * even if the in-memory map drifted (hot reload, missed updates, prune races).
   */
  private syncActiveRequestsFromEntries(now = this.now()): void {
    const previous = new Map(this.activeRequests)
    this.activeRequests.clear()
    this.pendingRequestKind = null
    const cutoff = now - STALE_ACTIVE_MS
    for (const entry of this.entries) {
      if (entry.timestamp < cutoff) continue
      this.updateActiveRequests(entry, now)
    }

    // Replay window may no longer contain the line that revealed the kind.
    for (const [taskId, prev] of previous) {
      const current = this.activeRequests.get(taskId)
      if (current && current.kind == null && prev.kind != null) {
        current.kind = prev.kind
      }
      if (current && current.model == null && prev.model != null) {
        current.model = prev.model
      }
      // App-managed loads have no runner slot lines — keep them across replay.
      if (!current && prev.managed) {
        this.activeRequests.set(taskId, prev)
      }
    }

    // Active tasks that fell out of the replay window were never completed → stale.
    for (const [, req] of previous) {
      if (req.status === 'active' && !this.activeRequests.has(req.taskId)) {
        this.archiveRequest(req, 'stale', now, req.completionReason)
      }
    }

    this.pruneActiveRequests(now)
  }

  private updateActiveRequests(entry: LogEntry, pruneNow?: number): void {
    const p = entry.parsed

    if (this.vendor === 'tabby' && p?.taskId != null && p.isRequest) {
      const now = entry.timestamp
      const existing = this.activeRequests.get(p.taskId)
      const req: ActiveRequest = existing ?? {
        taskId: p.taskId,
        slotId: null,
        kind: 'chat',
        model: null,
        phase: 'generation',
        progressPercent: null,
        nTokens: null,
        promptTokens: null,
        generationTokens: null,
        elapsedSeconds: null,
        tokensPerSec: null,
        promptTokensPerSec: null,
        generationTokensPerSec: null,
        firstSeenAt: now,
        updatedAt: now,
        status: 'active',
        completionReason: null
      }
      if (p.nTokens != null) {
        req.nTokens = p.nTokens
        req.generationTokens = p.nTokens
      }
      if (p.elapsedSeconds != null) req.elapsedSeconds = p.elapsedSeconds
      if (p.generationTokensPerSec != null) {
        req.generationTokensPerSec = p.generationTokensPerSec
        req.tokensPerSec = p.generationTokensPerSec
      }
      if (p.promptTokensPerSec != null) req.promptTokensPerSec = p.promptTokensPerSec
      req.updatedAt = now
      if (p.isTaskComplete) {
        req.status = 'completed'
        req.phase = 'done'
        req.progressPercent = 100
        this.activeRequests.set(p.taskId, req)
        this.archiveRequest(req, 'done', now, null)
      } else {
        this.activeRequests.set(p.taskId, req)
      }
      this.pruneActiveRequests(pruneNow ?? this.now())
      return
    }

    if (p?.requestKind && !p.isSlotActivity) {
      this.pendingRequestKind = { kind: p.requestKind, at: entry.timestamp }
    }

    if (!p?.isSlotActivity || p.taskId == null || p.taskId < 0) {
      if (p?.routeKind) this.backfillRouteKind(p.routeKind, entry.timestamp)
      return
    }

    const now = entry.timestamp
    const existing = this.activeRequests.get(p.taskId)
    const req: ActiveRequest = existing ?? {
      taskId: p.taskId,
      slotId: p.slotId ?? null,
      kind: this.takePendingRequestKind(now),
      model: null,
      phase: p.phase ?? 'unknown',
      progressPercent: null,
      nTokens: null,
      promptTokens: null,
      generationTokens: null,
      elapsedSeconds: null,
      tokensPerSec: null,
      promptTokensPerSec: null,
      generationTokensPerSec: null,
      firstSeenAt: now,
      updatedAt: now,
      status: 'active',
      completionReason: null
    }

    if (p.slotId != null) req.slotId = p.slotId
    if (req.kind == null) req.kind = this.takePendingRequestKind(now)
    if (p.phase) {
      // Prefer inference phases over transient cache/kv operator lines.
      const preferKeep =
        (req.phase === 'prompt_processing' || req.phase === 'generation') &&
        p.phase === 'caching'
      if (!preferKeep) req.phase = p.phase
    }
    if (p.nTokens != null) {
      req.nTokens = p.nTokens
      if (p.tokenKind === 'prompt') req.promptTokens = p.nTokens
      else if (p.tokenKind === 'generation') req.generationTokens = p.nTokens
      else if (req.phase === 'prompt_processing') req.promptTokens = p.nTokens
      else if (req.phase === 'generation') req.generationTokens = p.nTokens
    }
    if (p.progress != null) {
      // Logs emit progress as 0–1 (e.g. 0.53); tolerate accidental percentages.
      req.progressPercent = p.progress <= 1 ? p.progress * 100 : p.progress
    }
    if (p.elapsedSeconds != null) req.elapsedSeconds = p.elapsedSeconds
    if (p.tokensPerSec != null) req.tokensPerSec = p.tokensPerSec
    if (p.promptTokensPerSec != null) req.promptTokensPerSec = p.promptTokensPerSec
    if (p.generationTokensPerSec != null) {
      req.generationTokensPerSec = p.generationTokensPerSec
    }
    if (p.completionReason) req.completionReason = p.completionReason

    if (p.isTaskComplete || p.phase === 'done') {
      req.status = 'completed'
      req.phase = 'done'
      // Live badge může ukázat 100 %; historie si drží naposledy pozorovaný progress z logů.
      const observedProgress = req.progressPercent
      req.progressPercent = 100
      this.activeRequests.set(p.taskId, req)
      // Archive only on live append — sync replay must not re-insert evicted history rows.
      if (pruneNow == null) {
        this.archiveRequest(req, 'done', now, req.completionReason, observedProgress)
      }
    } else {
      req.status = 'active'
      this.activeRequests.set(p.taskId, req)
    }

    req.updatedAt = now
    if (pruneNow == null) this.pruneActiveRequests(now)
  }

  private takePendingRequestKind(taskStartedAt: number): RequestKind | null {
    const pending = this.pendingRequestKind
    if (!pending) return null
    if (taskStartedAt - pending.at > REQUEST_KIND_MAX_AGE_MS) return null
    this.pendingRequestKind = null
    return pending.kind
  }

  /**
   * Route lines are logged after the response, so they can only label a task
   * whose kind stayed unknown — never overwrite what the runner reported.
   */
  private backfillRouteKind(kind: RequestKind, at: number): void {
    for (const req of this.activeRequests.values()) {
      if (req.status === 'completed' && req.kind == null && at - req.updatedAt <= ROUTE_HINT_MAX_AGE_MS) {
        req.kind = kind
      }
    }
    const newest = this.requestHistory.find(
      (h) => h.kind == null && at - h.completedAt <= ROUTE_HINT_MAX_AGE_MS
    )
    if (newest) newest.kind = kind
  }

  private pruneActiveRequests(now = this.now()): void {
    for (const [taskId, req] of this.activeRequests) {
      if (req.status === 'completed' && now - req.updatedAt > COMPLETED_RETENTION_MS) {
        // Already snapshotted on completion; just drop from live map.
        this.activeRequests.delete(taskId)
        continue
      }
      if (req.status === 'active' && now - req.updatedAt > STALE_ACTIVE_MS) {
        if (req.managed) continue
        this.archiveRequest(req, 'stale', now, req.completionReason)
        this.activeRequests.delete(taskId)
      }
    }
  }

  private archiveRequest(
    req: ActiveRequest,
    result: RequestHistoryResult,
    completedAt: number,
    completionReason: string | null,
    /** Observed progress only — do not pass fabricated 100% unless seen in logs. */
    progressPercent: number | null = req.progressPercent
  ): void {
    // Runner emits many short-lived operator/cache task ids — do not let those
    // flood history and evict real completions.
    if (result === 'stale' && !isMeaningfulRequest(req)) return

    const item: RequestHistoryItem = {
      taskId: req.taskId,
      slotId: req.slotId,
      kind: req.kind,
      model: req.model,
      phase: result === 'done' || result === 'error' ? 'done' : req.phase === 'done' ? null : req.phase,
      result,
      completionReason,
      progressPercent,
      promptTokens: req.promptTokens,
      generationTokens: req.generationTokens,
      elapsedSeconds: req.elapsedSeconds,
      promptTokensPerSec: req.promptTokensPerSec,
      generationTokensPerSec: req.generationTokensPerSec,
      startedAt: req.firstSeenAt,
      completedAt
    }

    const existingIdx = this.requestHistory.findIndex(
      (h) => h.taskId === item.taskId && h.startedAt === item.startedAt
    )

    if (existingIdx >= 0) {
      const prev = this.requestHistory[existingIdx]
      // Never downgrade a successful completion to stale via replay/prune races.
      if (prev.result === 'done' && result !== 'done') return
      // Update in place — do not reorder (sync replay must not reshuffle newest-first).
      this.requestHistory[existingIdx] = mergeHistoryItem(prev, item)
      return
    }

    // Stale must never evict a done row when history is already full of completions.
    if (result === 'stale' && this.requestHistory.length >= this.maxHistory) {
      const oldestStaleIdx = this.findOldestStaleIndex()
      if (oldestStaleIdx < 0) return
      this.requestHistory.splice(oldestStaleIdx, 1)
    }

    this.requestHistory.unshift(item)
    this.trimHistory()
  }

  /** Cap at maxHistory while preferring to drop stale noise before done rows. */
  private trimHistory(): void {
    while (this.requestHistory.length > this.maxHistory) {
      const staleIdx = this.findOldestStaleIndex()
      const dropIdx = staleIdx >= 0 ? staleIdx : this.requestHistory.length - 1
      this.requestHistory.splice(dropIdx, 1)
    }
  }

  private findOldestStaleIndex(): number {
    for (let i = this.requestHistory.length - 1; i >= 0; i--) {
      if (this.requestHistory[i]!.result === 'stale') return i
    }
    return -1
  }

  /**
   * Record an app-initiated action (model load) that has no runner slot task id.
   * Returns the synthetic task id used in active/history lists.
   */
  startManagedRequest(kind: RequestKind, model: string): number {
    const now = this.now()
    const taskId = this.nextManagedTaskId
    this.nextManagedTaskId -= 1
    if (this.nextManagedTaskId === -1) this.nextManagedTaskId = -2
    const req: ActiveRequest = {
      taskId,
      slotId: null,
      kind,
      model,
      phase: 'unknown',
      progressPercent: null,
      nTokens: null,
      promptTokens: null,
      generationTokens: null,
      elapsedSeconds: 0,
      tokensPerSec: null,
      promptTokensPerSec: null,
      generationTokensPerSec: null,
      firstSeenAt: now,
      updatedAt: now,
      status: 'active',
      completionReason: null,
      managed: true
    }
    this.activeRequests.set(taskId, req)
    return taskId
  }

  finishManagedRequest(
    taskId: number,
    result: Extract<RequestHistoryResult, 'done' | 'error'>,
    error?: string
  ): void {
    const req = this.activeRequests.get(taskId)
    if (!req?.managed) return
    const now = this.now()
    req.status = 'completed'
    req.phase = 'done'
    req.progressPercent = result === 'done' ? 100 : req.progressPercent
    req.elapsedSeconds = (now - req.firstSeenAt) / 1000
    req.completionReason = error?.trim() ? error : result === 'done' ? null : req.completionReason
    req.updatedAt = now
    this.archiveRequest(req, result, now, req.completionReason)
  }
}

/** True when logs showed real inference work (not cache/operator-only blips). */
function isMeaningfulRequest(req: ActiveRequest): boolean {
  if (req.managed) return true
  if (req.phase === 'prompt_processing' || req.phase === 'generation') return true
  if (req.progressPercent != null && req.progressPercent > 0) return true
  if (req.promptTokens != null || req.generationTokens != null) return true
  if (req.elapsedSeconds != null) return true
  if (req.promptTokensPerSec != null || req.generationTokensPerSec != null) return true
  return false
}

function mergeHistoryItem(prev: RequestHistoryItem, next: RequestHistoryItem): RequestHistoryItem {
  return {
    taskId: next.taskId,
    slotId: next.slotId ?? prev.slotId,
    kind: next.kind ?? prev.kind,
    model: next.model ?? prev.model,
    phase: next.phase ?? prev.phase,
    result: next.result === 'done' || prev.result === 'done' ? 'done' : next.result,
    completionReason: next.completionReason ?? prev.completionReason,
    progressPercent: next.progressPercent ?? prev.progressPercent,
    promptTokens: next.promptTokens ?? prev.promptTokens,
    generationTokens: next.generationTokens ?? prev.generationTokens,
    elapsedSeconds: next.elapsedSeconds ?? prev.elapsedSeconds,
    promptTokensPerSec: next.promptTokensPerSec ?? prev.promptTokensPerSec,
    generationTokensPerSec: next.generationTokensPerSec ?? prev.generationTokensPerSec,
    startedAt: prev.startedAt,
    completedAt: Math.max(prev.completedAt, next.completedAt)
  }
}

function parseExplicitLevel(line: string): LogLevel | undefined {
  const match = line.match(EXPLICIT_LEVEL_RE)
  if (!match) return undefined
  switch (match[1].toUpperCase()) {
    case 'DEBUG':
      return 'debug'
    case 'WARN':
    case 'WARNING':
      return 'warn'
    case 'ERROR':
    case 'FATAL':
      return 'error'
    default:
      return 'info'
  }
}

function detectCompletionReason(line: string): string | null {
  if (/\bslot\s+release\b/i.test(line)) return 'slot release'
  if (/\bstop(?:ped)?\s+processing\b/i.test(line)) return 'stop processing'
  if (/\bdone processing\b/i.test(line)) return 'done processing'
  return null
}

function detectPhase(line: string): ActiveRequestPhase | undefined {
  const lower = line.toLowerCase()
  if (/\bprompt\s+processing\b/.test(lower) || /\bprompt\s+eval\b/.test(lower)) {
    return 'prompt_processing'
  }
  // Prefill finished; decoder phase usually follows.
  if (/\bprompt\s+done\b/.test(lower)) return 'generation'
  if (/\bn_decoded\b/.test(lower) || /\btg\s*=/.test(lower)) return 'generation'
  if (/\bgenerat(?:e|ion|ing)\b/.test(lower)) return 'generation'
  // Bare "eval time" after prompt-eval check ≈ decode summary.
  if (/\beval\s+time\b/.test(lower)) return 'generation'
  if (/\bcached\s+n_tokens\b/.test(lower) || /\bmemory_seq_rm\b/.test(lower)) {
    return 'caching'
  }
  if (/\bnew prompt\b/.test(lower) || /\bprocessing task\b/.test(lower)) {
    return 'prompt_processing'
  }
  if (SLOT_DONE_RE.test(lower)) return 'done'
  return undefined
}

function detectRequestKind(line: string): RequestKind | undefined {
  const match = line.match(REQUEST_KIND_RE)
  if (match) {
    switch (match[1].toLowerCase()) {
      case 'chat':
        return 'chat'
      case 'completion':
        return 'generate'
      default:
        return 'embed'
    }
  }
  if (CHAT_FORMAT_RE.test(line)) return 'chat'
  return undefined
}

function detectRouteKind(line: string): RequestKind | undefined {
  const match = line.match(REQUEST_ROUTE_RE)
  if (!match) return undefined
  const route = match[1].toLowerCase()
  if (route === 'chat') return 'chat'
  if (route === 'generate') return 'generate'
  return 'embed'
}

function parseLine(line: string): ParsedLogEvent {
  const parsed: ParsedLogEvent = {
    isLoad: LOAD_RE.test(line),
    isUnload: UNLOAD_RE.test(line),
    isError: ERROR_RE.test(line),
    isRequest: REQUEST_RE.test(line)
  }

  const requestKind = detectRequestKind(line)
  if (requestKind) parsed.requestKind = requestKind
  const routeKind = detectRouteKind(line)
  if (routeKind) parsed.routeKind = routeKind

  const dur = line.match(DURATION_RE)
  if (dur) {
    let ms = parseFloat(dur[1])
    if (dur[2] === 's') ms *= 1000
    parsed.durationMs = ms
  }

  const promptTps = line.match(PROMPT_TPS_RE)
  if (promptTps) {
    const value = parseTps(promptTps[1])
    if (value !== null) parsed.promptTokensPerSec = value
  }

  const genTps = line.match(GEN_TPS_RE) ?? line.match(ALT_TPS_RE)
  if (genTps) {
    const value = parseTps(genTps[1])
    if (value !== null) parsed.generationTokensPerSec = value
  }

  const slotHeader = line.match(SLOT_HEADER_RE)
  if (slotHeader) {
    const taskId = parseInt(slotHeader[2], 10)
    // Scheduler placeholder tasks (task -1) are not user requests.
    if (taskId < 0) {
      return parsed
    }

    parsed.isSlotActivity = true
    parsed.isRequest = true
    parsed.slotId = parseInt(slotHeader[1], 10)
    parsed.taskId = taskId
    parsed.phase = detectPhase(line)

    const progress = line.match(SLOT_PROGRESS_RE)
    if (progress) parsed.progress = parseFloat(progress[1])

    const nDecoded = line.match(SLOT_N_DECODED_RE)
    if (nDecoded) {
      parsed.nTokens = parseInt(nDecoded[1], 10)
      parsed.tokenKind = 'generation'
      parsed.phase = parsed.phase ?? 'generation'
    }

    const nTokens = line.match(SLOT_N_TOKENS_RE)
    if (nTokens) {
      parsed.nTokens = parseInt(nTokens[1], 10)
      if (parsed.phase === 'prompt_processing') parsed.tokenKind = 'prompt'
      else if (parsed.phase === 'generation') parsed.tokenKind = 'generation'
    }

    if (parsed.nTokens == null) {
      const summaryTokens = line.match(SLOT_SUMMARY_TOKENS_RE)
      if (summaryTokens) parsed.nTokens = parseInt(summaryTokens[1], 10)
    }

    const elapsed = line.match(SLOT_ELAPSED_RE)
    if (elapsed) parsed.elapsedSeconds = parseFloat(elapsed[1])

    const tg = line.match(SLOT_TG_TPS_RE)
    if (tg) {
      const value = parseTps(tg[1])
      if (value !== null) {
        parsed.tokensPerSec = value
        parsed.generationTokensPerSec = value
      }
      parsed.phase = parsed.phase ?? 'generation'
    }

    const tps = line.match(SLOT_TPS_RE)
    if (tps) {
      const value = parseTps(tps[1])
      if (value !== null) {
        parsed.tokensPerSec = value
        if (parsed.phase === 'generation') {
          parsed.generationTokensPerSec = value
        } else if (parsed.phase === 'prompt_processing') {
          parsed.promptTokensPerSec = value
          // Prefer live prompt throughput for rolling average while prefill is active.
          parsed.generationTokensPerSec = value
        }
      }
    }

    if (parsed.phase === 'done' || SLOT_DONE_RE.test(line)) {
      parsed.isTaskComplete = true
      parsed.phase = parsed.phase ?? 'done'
      const reason = detectCompletionReason(line)
      if (reason) parsed.completionReason = reason
    }
  }

  return parsed
}

export const logBuffer = new LogBuffer()
