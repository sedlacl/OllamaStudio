/**
 * Best-effort parser TabbyAPI logů (uvicorn / loguru).
 * Formát není stabilní API — dashboard musí umět „nedostupné“.
 */

export interface TabbyLogEvent {
  isRequest?: boolean
  isComplete?: boolean
  requestId?: string
  generationTokens?: number
  generationTokensPerSec?: number
  promptTokens?: number
  promptTokensPerSec?: number
  cachedTokens?: number
  contextTokens?: number
  queueSeconds?: number
  elapsedSeconds?: number
  isLoad?: boolean
  isUnload?: boolean
  isError?: boolean
}

const RECEIVED_RE =
  /Received (?:chat completion|completion)(?: streaming)? request\s+([a-f0-9]+)/i
const FINISHED_RE =
  /Finished (?:chat completion|completion)(?: streaming)? request\s+([a-f0-9]+)/i
/** `Metrics (ID: x): 76 tokens generated in 3.91 seconds` — hlavička bez itemizace. */
const METRICS_HEAD_RE =
  /Metrics \(ID:\s*([a-f0-9]+)\):\s*(\d+)\s+tokens generated in\s+([\d.]+)\s+seconds/i
const METRICS_QUEUE_RE = /Queue:\s*([\d.]+)\s*s\b/i
/** `Process: 12288 cached tokens and 405 new tokens at 358.41 T/s` */
const METRICS_PROCESS_RE =
  /Process:\s*(\d+)\s+cached tokens and\s+(\d+)\s+new tokens at\s+([\d.]+)\s*T\/s/i
const METRICS_GENERATE_RE = /Generate:\s*([\d.]+)\s*T\/s/i
const METRICS_CONTEXT_RE = /Context:\s*(\d+)\s+tokens/i
const LOAD_RE = /Loading model:|Model successfully loaded/i
const UNLOAD_RE = /Unloading (?:existing )?model/i
const ERROR_RE = /\b(ERROR|Error|Traceback|Exception)\b/

/**
 * Nový logický řádek Tabby: `2026-09-10 20:23:08.713 INFO: …` nebo bare
 * uvicorn `INFO:     127.0.0.1 …`. Cokoli jiného je pokračování zalomeného
 * řádku z Rich konzole (viz `assembleTabbyLogLine`).
 */
const LINE_START_RE =
  /^(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}|(?:TRACE|DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\s*:)/

/** Delší text už nemůže být rozpracovaná metrika — nedrž ho v paměti. */
const MAX_ASSEMBLED_LENGTH = 8192

export function isTabbyLogLineStart(line: string): boolean {
  return LINE_START_RE.test(line)
}

/**
 * Rich konzole zalamuje na šířku terminálu, takže `Metrics (ID: …)` doteče na
 * stdout rozsekaná na několik fyzických řádků. Vrací text pro parsování:
 * u nového řádku jen jeho obsah, u pokračování předchozí text + řádek.
 * Zalomení je na hranici slova včetně mezery, proto se spojuje bez separátoru.
 */
export function assembleTabbyLogLine(pending: string, line: string): string {
  if (isTabbyLogLineStart(line) || !pending) return line.slice(0, MAX_ASSEMBLED_LENGTH)
  const joined = pending + line
  return joined.length > MAX_ASSEMBLED_LENGTH
    ? joined.slice(joined.length - MAX_ASSEMBLED_LENGTH)
    : joined
}

/**
 * Klasifikace (load/unload/error) se dělá nad fyzickým řádkem, request metriky
 * nad složeným textem — jinak by pokračování dědilo `ERROR` z hlavičky.
 */
export function parseTabbyLogLine(line: string, assembled?: string): TabbyLogEvent {
  const event: TabbyLogEvent = {
    isLoad: LOAD_RE.test(line),
    isUnload: UNLOAD_RE.test(line),
    isError: ERROR_RE.test(line) && !/level=INFO/i.test(line)
  }

  const text = assembled ?? line

  const received = text.match(RECEIVED_RE)
  if (received) {
    event.isRequest = true
    event.requestId = received[1]
  }

  const finished = text.match(FINISHED_RE)
  if (finished) {
    event.isRequest = true
    event.isComplete = true
    event.requestId = finished[1]
  }

  const head = text.match(METRICS_HEAD_RE)
  if (head) {
    event.isRequest = true
    event.isComplete = true
    event.requestId = head[1]
    event.generationTokens = parseInt(head[2], 10)
    event.elapsedSeconds = parseFloat(head[3])

    const queue = text.match(METRICS_QUEUE_RE)
    if (queue) event.queueSeconds = parseFloat(queue[1])

    const process = text.match(METRICS_PROCESS_RE)
    if (process) {
      const cached = parseInt(process[1], 10)
      const fresh = parseInt(process[2], 10)
      event.cachedTokens = cached
      event.promptTokens = cached + fresh
      event.promptTokensPerSec = parseFloat(process[3])
    }

    const generate = text.match(METRICS_GENERATE_RE)
    if (generate) event.generationTokensPerSec = parseFloat(generate[1])

    const context = text.match(METRICS_CONTEXT_RE)
    if (context) event.contextTokens = parseInt(context[1], 10)
  }

  return event
}
