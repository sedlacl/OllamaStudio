export type LogLevel = 'info' | 'error' | 'warn' | 'debug'

export type LogCategory = 'general' | 'error' | 'load' | 'unload' | 'request'

export interface ParsedLogEvent {
  durationMs?: number
  promptTokensPerSec?: number
  generationTokensPerSec?: number
  isLoad?: boolean
  isUnload?: boolean
  isError?: boolean
  isRequest?: boolean
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

const LOAD_RE = /load(?:ing|ed)?\s+(?:model|weights)?/i
const UNLOAD_RE = /unload(?:ing|ed)?/i
const ERROR_RE = /error|fatal|panic|failed/i
const REQUEST_RE = /(?:POST|GET)\s+\/api\/|request|inference|generate|chat/i
const DURATION_RE = /duration[=:\s]+([\d.]+)\s*(ms|s)?/i
const PROMPT_TPS_RE = /prompt\s+eval\s+(?:rate|tok\/s)[=:\s]+([\d.]+)/i
const GEN_TPS_RE = /(?:generation|eval)\s+(?:rate|tok\/s)[=:\s]+([\d.]+)/i
const ALT_TPS_RE = /([\d.]+)\s+tok(?:en)?s?\/s/i

export class LogBuffer {
  private entries: LogEntry[] = []
  private nextId = 1
  private listeners = new Set<(entry: LogEntry) => void>()
  private fileStream: { write: (s: string) => void } | null = null
  private recentGenTps: number[] = []
  private activeRequestEstimate = 0

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
    return this.activeRequestEstimate > 0 ? this.activeRequestEstimate : null
  }

  clear(): void {
    this.entries = []
    this.recentGenTps = []
    this.activeRequestEstimate = 0
  }

  private createEntry(stream: 'stdout' | 'stderr', line: string): LogEntry {
    const parsed = parseLine(line)
    let category: LogCategory = 'general'
    if (parsed.isError || stream === 'stderr') category = 'error'
    else if (parsed.isLoad) category = 'load'
    else if (parsed.isUnload) category = 'unload'
    else if (parsed.isRequest) category = 'request'

    const level: LogLevel =
      category === 'error' ? 'error' : stream === 'stderr' ? 'warn' : 'info'

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
    if (entry.parsed?.isRequest) {
      this.activeRequestEstimate = Math.min(this.activeRequestEstimate + 1, 99)
    }
    if (entry.parsed?.durationMs !== undefined) {
      this.activeRequestEstimate = Math.max(0, this.activeRequestEstimate - 1)
    }
  }
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

  return parsed
}

export const logBuffer = new LogBuffer()
