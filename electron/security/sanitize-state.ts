import {
  REDACTION_MARKER,
  sanitizeErrorMessage,
  sanitizeSecrets,
  sanitizeUrl
} from './secret-redactor'

const PULL_PROGRESS_MAX_DEPTH = 32
const PULL_PROGRESS_MAX_KEYS = 256
const PULL_PROGRESS_MAX_ARRAY_LENGTH = 1024

export interface SanitizedUpdateInfo {
  current: string | null
  latest: string | null
  updateAvailable: boolean
  releaseUrl: string
  checkedAt: number
  error?: string
}

/** Sanitizace neznámé chyby před uložením do stavu nebo IPC. */
export function sanitizeUnknownError(err: unknown): string {
  if (err instanceof Error) return sanitizeErrorMessage(err.message)
  return sanitizeSecrets(String(err))
}

/** Sanitizace volitelného error pole ve stavu. */
export function sanitizeOptionalError(error: string | null | undefined): string | null | undefined {
  if (error == null) return error
  const cleaned = sanitizeErrorMessage(error)
  return cleaned || null
}

/**
 * Sanitizace cesty pro stav/IPC — zachová funkční tvar, odstraní query/hash
 * a credential-like segmenty (interní operace mohou použít raw resolved path).
 */
export function sanitizePathForState(path: string): string {
  if (!path) return path
  const withoutQuery = path.split(/[?#]/)[0]
  return sanitizeSecrets(withoutQuery)
}

/** Sanitizace Ollama update cache / IPC odpovědi. */
export function sanitizeUpdateInfo(info: SanitizedUpdateInfo): SanitizedUpdateInfo {
  return {
    ...info,
    releaseUrl: sanitizeUrl(info.releaseUrl),
    error: info.error ? sanitizeOptionalError(info.error) ?? undefined : undefined
  }
}

/** Sanitizace výsledku kill operace před IPC. */
export function sanitizeKillProcessResult(result: {
  ok: boolean
  error?: string
}): { ok: boolean; error?: string } {
  if (!result.error) return result
  return { ...result, error: sanitizeUnknownError(result.error) }
}

/** Sanitizace scrub výsledku — path a error před IPC. */
export function sanitizeScrubResult(result: {
  ok: boolean
  path: string
  linesRead: number
  linesChanged: number
  error?: string
}): typeof result {
  return {
    ...result,
    path: sanitizePathForState(result.path),
    error: result.error ? sanitizeUnknownError(result.error) : undefined
  }
}

export interface SanitizedSpeedTestResult {
  model: string
  prompt: string
  response: string
  ttftMs: number
  tokensPerSecond: number
  generatedTokens: number
  thinking: string
  promptTokensPerSecond: number
  promptTokens: number
  promptEvalMs: number
  totalMs: number
  loadMs: number
  wasLoaded: boolean
}

export interface SanitizedPullProgress {
  status: string
  digest?: string
  total?: number
  completed?: number
}

/** Sanitizace speed test výsledku před cache/IPC. */
export function sanitizeSpeedTestResult<T extends SanitizedSpeedTestResult>(result: T): T {
  return {
    ...result,
    model: sanitizeSecrets(result.model),
    prompt: sanitizeSecrets(result.prompt),
    response: sanitizeSecrets(result.response),
    thinking: sanitizeSecrets(result.thinking)
  }
}

function sanitizePullProgressNode(
  value: unknown,
  seen: WeakSet<object>,
  depth: number
): unknown {
  if (depth > PULL_PROGRESS_MAX_DEPTH) return REDACTION_MARKER
  if (value == null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : REDACTION_MARKER
  if (typeof value === 'string') return sanitizeSecrets(value)
  if (Array.isArray(value)) {
    if (value.length > PULL_PROGRESS_MAX_ARRAY_LENGTH) return REDACTION_MARKER
    return value.map((item) => sanitizePullProgressNode(item, seen, depth + 1))
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return REDACTION_MARKER
    seen.add(value)
    const raw = value as Record<string, unknown>
    const entries = Object.entries(raw)
    if (entries.length > PULL_PROGRESS_MAX_KEYS) return REDACTION_MARKER
    const out: Record<string, unknown> = {}
    for (const [key, nested] of entries) {
      out[key] = sanitizePullProgressNode(nested, seen, depth + 1)
    }
    return out
  }
  return sanitizeSecrets(String(value))
}

/** Rekurzivní sanitizace Ollama pull progress před IPC eventem; numerické progress fields zachová. */
export function sanitizePullProgress(value: unknown): SanitizedPullProgress {
  if (value == null || typeof value !== 'object') {
    return { status: sanitizeSecrets(String(value ?? '')) }
  }
  const sanitized = sanitizePullProgressNode(value, new WeakSet(), 0)
  if (typeof sanitized !== 'object' || sanitized == null || Array.isArray(sanitized)) {
    return { status: REDACTION_MARKER }
  }
  const raw = sanitized as Record<string, unknown>
  const out: Record<string, unknown> = {
    status:
      typeof raw.status === 'string'
        ? raw.status
        : sanitizeSecrets(String(raw.status ?? ''))
  }
  if (typeof raw.digest === 'string') out.digest = raw.digest
  if (typeof raw.total === 'number' && Number.isFinite(raw.total)) out.total = raw.total
  if (typeof raw.completed === 'number' && Number.isFinite(raw.completed)) out.completed = raw.completed
  for (const [key, nested] of Object.entries(raw)) {
    if (key === 'status' || key === 'digest' || key === 'total' || key === 'completed') continue
    out[key] = nested
  }
  return out as unknown as SanitizedPullProgress
}

export { sanitizeUrl, sanitizeSecrets, sanitizeErrorMessage }
