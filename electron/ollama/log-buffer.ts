export type LogLevel = 'info' | 'error' | 'warn' | 'debug'

export type LogCategory = 'general' | 'error' | 'load' | 'unload' | 'request'

export type ActiveRequestPhase =
  | 'prompt_processing'
  | 'generation'
  | 'caching'
  | 'done'
  | 'unknown'

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
  progress?: number
  elapsedSeconds?: number
  tokensPerSec?: number
  isSlotActivity?: boolean
  isTaskComplete?: boolean
}

export interface ActiveRequest {
  taskId: number
  slotId: number | null
  phase: ActiveRequestPhase
  /** 0–100 when known from logs; null when absent (do not invent). */
  progressPercent: number | null
  nTokens: number | null
  elapsedSeconds: number | null
  tokensPerSec: number | null
  firstSeenAt: number
  updatedAt: number
  status: 'active' | 'completed'
}

export interface LogEntry {
  id: number
  timestamp: number
  stream: 'stdout' | 'stderr'
  text: string
  level: LogLevel
  category: LogCategory
  parsed?: ParsedLogEvent
}

const MAX_ENTRIES = 5000
/** Keep completed tasks briefly so the UI can show a short done state. */
const COMPLETED_RETENTION_MS = 8_000
/** Drop tasks with no log updates (stale/aborted). */
const STALE_ACTIVE_MS = 90_000

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
/** Prompt/eval summary token count: `ms / 290 tokens` */
const SLOT_SUMMARY_TOKENS_RE = /\/\s*(\d+)\s+tokens\b/i
/**
 * Reliable completion only — avoid broad words like "finished/complete"
 * that appear in unrelated runner/debug text on the same line family.
 */
const SLOT_DONE_RE =
  /\bslot\s+release\b|\bstop(?:ped)?\s+processing\b|\bdone processing\b/i

export class LogBuffer {
  private entries: LogEntry[] = []
  private nextId = 1
  private listeners = new Set<(entry: LogEntry) => void>()
  private fileStream: { write: (s: string) => void } | null = null
  private recentGenTps: number[] = []
  private activeRequestEstimate = 0
  private activeRequests = new Map<number, ActiveRequest>()

  setFileWriter(writer: { write: (s: string) => void } | null): void {
    this.fileStream = writer
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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
    return [...this.activeRequests.values()].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
  }

  clear(): void {
    this.entries = []
    this.recentGenTps = []
    this.activeRequestEstimate = 0
    this.activeRequests.clear()
  }

  private createEntry(stream: 'stdout' | 'stderr', line: string): LogEntry {
    const parsed = parseLine(line)
    const explicitLevel = parseExplicitLevel(line)
    // Runner slot lines arrive on stderr without level=; they are not errors.
    const stderrIsError =
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
          : stream === 'stderr'
            ? 'warn'
            : 'info')

    return {
      id: this.nextId++,
      timestamp: Date.now(),
      stream,
      text: line,
      level,
      category,
      parsed
    }
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
  private syncActiveRequestsFromEntries(now = Date.now()): void {
    this.activeRequests.clear()
    const cutoff = now - STALE_ACTIVE_MS
    for (const entry of this.entries) {
      if (entry.timestamp < cutoff) continue
      this.updateActiveRequests(entry, now)
    }
    this.pruneActiveRequests(now)
  }

  private updateActiveRequests(entry: LogEntry, pruneNow?: number): void {
    const p = entry.parsed
    if (!p?.isSlotActivity || p.taskId == null || p.taskId < 0) return

    const now = entry.timestamp
    const existing = this.activeRequests.get(p.taskId)
    const req: ActiveRequest = existing ?? {
      taskId: p.taskId,
      slotId: p.slotId ?? null,
      phase: p.phase ?? 'unknown',
      progressPercent: null,
      nTokens: null,
      elapsedSeconds: null,
      tokensPerSec: null,
      firstSeenAt: now,
      updatedAt: now,
      status: 'active'
    }

    if (p.slotId != null) req.slotId = p.slotId
    if (p.phase) {
      // Prefer inference phases over transient cache/kv operator lines.
      const preferKeep =
        (req.phase === 'prompt_processing' || req.phase === 'generation') &&
        p.phase === 'caching'
      if (!preferKeep) req.phase = p.phase
    }
    if (p.nTokens != null) req.nTokens = p.nTokens
    if (p.progress != null) {
      // Logs emit progress as 0–1 (e.g. 0.53); tolerate accidental percentages.
      req.progressPercent = p.progress <= 1 ? p.progress * 100 : p.progress
    }
    if (p.elapsedSeconds != null) req.elapsedSeconds = p.elapsedSeconds
    if (p.tokensPerSec != null) req.tokensPerSec = p.tokensPerSec

    if (p.isTaskComplete || p.phase === 'done') {
      req.status = 'completed'
      req.phase = 'done'
      req.progressPercent = 100
    } else {
      req.status = 'active'
    }

    req.updatedAt = now
    this.activeRequests.set(p.taskId, req)
    if (pruneNow == null) this.pruneActiveRequests(now)
  }

  private pruneActiveRequests(now = Date.now()): void {
    for (const [taskId, req] of this.activeRequests) {
      if (req.status === 'completed' && now - req.updatedAt > COMPLETED_RETENTION_MS) {
        this.activeRequests.delete(taskId)
        continue
      }
      if (req.status === 'active' && now - req.updatedAt > STALE_ACTIVE_MS) {
        this.activeRequests.delete(taskId)
      }
    }
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

function parseLine(line: string): ParsedLogEvent {
  const parsed: ParsedLogEvent = {
    isLoad: LOAD_RE.test(line),
    isUnload: UNLOAD_RE.test(line),
    isError: ERROR_RE.test(line),
    isRequest: REQUEST_RE.test(line)
  }

  const dur = line.match(DURATION_RE)
  if (dur) {
    let ms = parseFloat(dur[1])
    if (dur[2] === 's') ms *= 1000
    parsed.durationMs = ms
  }

  const promptTps = line.match(PROMPT_TPS_RE)
  if (promptTps) parsed.promptTokensPerSec = parseFloat(promptTps[1])

  const genTps = line.match(GEN_TPS_RE) ?? line.match(ALT_TPS_RE)
  if (genTps) parsed.generationTokensPerSec = parseFloat(genTps[1])

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
      parsed.phase = parsed.phase ?? 'generation'
    }

    const nTokens = line.match(SLOT_N_TOKENS_RE)
    if (nTokens) parsed.nTokens = parseInt(nTokens[1], 10)

    if (parsed.nTokens == null) {
      const summaryTokens = line.match(SLOT_SUMMARY_TOKENS_RE)
      if (summaryTokens) parsed.nTokens = parseInt(summaryTokens[1], 10)
    }

    const elapsed = line.match(SLOT_ELAPSED_RE)
    if (elapsed) parsed.elapsedSeconds = parseFloat(elapsed[1])

    const tg = line.match(SLOT_TG_TPS_RE)
    if (tg) {
      parsed.tokensPerSec = parseFloat(tg[1])
      parsed.generationTokensPerSec = parsed.tokensPerSec
      parsed.phase = parsed.phase ?? 'generation'
    }

    const tps = line.match(SLOT_TPS_RE)
    if (tps) {
      parsed.tokensPerSec = parseFloat(tps[1])
      if (parsed.phase === 'generation') {
        parsed.generationTokensPerSec = parsed.tokensPerSec
      } else if (parsed.phase === 'prompt_processing') {
        parsed.promptTokensPerSec = parsed.tokensPerSec
        // Prefer live prompt throughput for rolling average while prefill is active.
        parsed.generationTokensPerSec = parsed.tokensPerSec
      }
    }

    if (parsed.phase === 'done' || SLOT_DONE_RE.test(line)) {
      parsed.isTaskComplete = true
      parsed.phase = parsed.phase ?? 'done'
    }
  }

  return parsed
}

export const logBuffer = new LogBuffer()
