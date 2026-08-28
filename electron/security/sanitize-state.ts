import { sanitizeErrorMessage, sanitizeSecrets, sanitizeUrl } from './secret-redactor'

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

export { sanitizeUrl, sanitizeSecrets, sanitizeErrorMessage }
