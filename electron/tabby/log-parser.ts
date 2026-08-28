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
  promptTokensPerSec?: number
  elapsedSeconds?: number
  isLoad?: boolean
  isUnload?: boolean
  isError?: boolean
}

const RECEIVED_RE =
  /Received (?:chat completion|completion) request\s+([a-f0-9]+)/i
const FINISHED_RE =
  /Finished (?:chat completion|completion) request\s+([a-f0-9]+)/i
const METRICS_RE =
  /Metrics \(ID:\s*([a-f0-9]+)\):\s*(\d+)\s+tokens generated in\s+([\d.]+)\s+seconds.*?Generate:\s*([\d.]+)\s*T\/s/i
const LOAD_RE = /Loading model:|Model successfully loaded/i
const UNLOAD_RE = /Unloading (?:existing )?model/i
const ERROR_RE = /\b(ERROR|Error|Traceback|Exception)\b/

export function parseTabbyLogLine(line: string): TabbyLogEvent {
  const event: TabbyLogEvent = {
    isLoad: LOAD_RE.test(line),
    isUnload: UNLOAD_RE.test(line),
    isError: ERROR_RE.test(line) && !/level=INFO/i.test(line)
  }

  const received = line.match(RECEIVED_RE)
  if (received) {
    event.isRequest = true
    event.requestId = received[1]
  }

  const finished = line.match(FINISHED_RE)
  if (finished) {
    event.isRequest = true
    event.isComplete = true
    event.requestId = finished[1]
  }

  const metrics = line.match(METRICS_RE)
  if (metrics) {
    event.isRequest = true
    event.isComplete = true
    event.requestId = metrics[1]
    event.generationTokens = parseInt(metrics[2], 10)
    event.elapsedSeconds = parseFloat(metrics[3])
    event.generationTokensPerSec = parseFloat(metrics[4])
  }

  return event
}
