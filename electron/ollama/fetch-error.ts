import { redactSecrets } from '../tabby/hf-download-helpers'

const USELESS_MESSAGE =
  /^(fetch failed|failed to fetch|networkerror when attempting to fetch resource|network)$/i

const SECRET_QUERY =
  /^(token|key|api[_-]?key|access[_-]?token|auth|authorization|password|secret|admin[_-]?key|hf[_-]?token)$/i

const ADDR_IN_MESSAGE =
  /(?:connect\s+)?(?:ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND)\s+(\S+)/i

const HTTP_STATUS_RE = /\bHTTP\s+(\d{3})\b/i

export type NetworkKind =
  | 'connRefused'
  | 'timedOut'
  | 'connReset'
  | 'dnsFailed'
  | 'aborted'
  | 'http'
  | 'generic'

export interface CauseLink {
  message: string
  name?: string
  code?: string
  address?: string
  port?: number
  url?: string
}

export interface FetchErrorInfo {
  kind: NetworkKind
  code: string | null
  target: string | null
  url: string | null
  httpStatus: number | null
  messages: string[]
  /** Stable key for duplicate suppression. */
  dedupeKey: string
  /** Technical line for the app log — never a bare "fetch failed". */
  logLine: string
}

export type FetchErrorTranslator = (
  key:
    | 'errors.connRefused'
    | 'errors.timedOut'
    | 'errors.connReset'
    | 'errors.dnsFailed'
    | 'errors.aborted'
    | 'errors.httpStatus'
    | 'errors.networkFailed',
  vars?: Record<string, string | number>
) => string

export class NetworkError extends Error {
  readonly url: string

  constructor(url: string, cause: unknown) {
    super('fetch failed', {
      cause: cause instanceof Error ? cause : new Error(String(cause))
    })
    this.name = 'NetworkError'
    this.url = stripUrlSecrets(url)
  }
}

export function stripUrlSecrets(url: string): string {
  const cleaned = redactSecrets(url)
  try {
    const parsed = new URL(cleaned)
    for (const key of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY.test(key)) parsed.searchParams.set(key, '***')
    }
    if (parsed.username) parsed.username = '***'
    if (parsed.password) parsed.password = '***'
    return redactSecrets(parsed.toString())
  } catch {
    return redactSecrets(cleaned).replace(
      /([?&](?:token|key|api[_-]?key|access[_-]?token|authorization|admin[_-]?key|hf[_-]?token|password|secret)=)[^&\s]*/gi,
      '$1***'
    )
  }
}

export function extractCauseChain(err: unknown, max = 6): CauseLink[] {
  const out: CauseLink[] = []
  const seen = new Set<unknown>()
  let current: unknown = err
  while (current != null && out.length < max && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) {
      const extra = current as Error & {
        code?: unknown
        address?: unknown
        port?: unknown
        url?: unknown
      }
      out.push({
        message: extra.message,
        name: extra.name,
        code: typeof extra.code === 'string' ? extra.code : undefined,
        address: typeof extra.address === 'string' ? extra.address : undefined,
        port: typeof extra.port === 'number' ? extra.port : undefined,
        url: typeof extra.url === 'string' ? extra.url : undefined
      })
      current = extra.cause
      continue
    }
    if (typeof current === 'object' && current !== null && 'message' in current) {
      const extra = current as {
        message?: unknown
        name?: unknown
        code?: unknown
        address?: unknown
        port?: unknown
        cause?: unknown
      }
      out.push({
        message: typeof extra.message === 'string' ? extra.message : String(extra.message),
        name: typeof extra.name === 'string' ? extra.name : undefined,
        code: typeof extra.code === 'string' ? extra.code : undefined,
        address: typeof extra.address === 'string' ? extra.address : undefined,
        port: typeof extra.port === 'number' ? extra.port : undefined
      })
      current = extra.cause
      continue
    }
    out.push({ message: String(current) })
    break
  }
  return out
}

export function classifyNetworkCode(
  code: string | null,
  name?: string,
  message?: string
): NetworkKind {
  const c = (code ?? '').toUpperCase()
  const n = (name ?? '').toLowerCase()
  const m = (message ?? '').toLowerCase()
  if (c === 'ECONNREFUSED' || m.includes('econnrefused')) return 'connRefused'
  if (
    c === 'ETIMEDOUT' ||
    c === 'UND_ERR_CONNECT_TIMEOUT' ||
    c === 'UND_ERR_HEADERS_TIMEOUT' ||
    n === 'timeouterror' ||
    /\btimeout(?:ed)?\b/.test(m)
  ) {
    return 'timedOut'
  }
  if (c === 'ECONNRESET' || c === 'UND_ERR_SOCKET' || m.includes('econnreset')) {
    return 'connReset'
  }
  if (
    c === 'ENOTFOUND' ||
    c === 'EAI_AGAIN' ||
    c === 'EHOSTUNREACH' ||
    m.includes('enotfound') ||
    m.includes('getaddrinfo')
  ) {
    return 'dnsFailed'
  }
  if (n === 'aborterror' || c === 'ABORT_ERR' || m.includes('aborted')) return 'aborted'
  if (HTTP_STATUS_RE.test(message ?? '')) return 'http'
  return 'generic'
}

function targetFromLink(link: CauseLink): string | null {
  if (link.address && link.port != null) return `${link.address}:${link.port}`
  if (link.address) return link.address
  const fromMessage = link.message.match(ADDR_IN_MESSAGE)
  if (fromMessage?.[1]) return fromMessage[1]
  if (link.url) {
    try {
      const u = new URL(link.url)
      return u.port ? `${u.hostname}:${u.port}` : u.host
    } catch {
      return null
    }
  }
  return null
}

function usefulMessages(chain: CauseLink[]): string[] {
  const out: string[] = []
  for (const link of chain) {
    const text = redactSecrets(link.message ?? '').trim()
    if (!text || USELESS_MESSAGE.test(text)) continue
    if (!out.includes(text)) out.push(text)
  }
  return out
}

export function inspectFetchError(err: unknown, fallbackUrl?: string): FetchErrorInfo {
  const chain = extractCauseChain(err)
  const urlFromChain = chain.find((l) => l.url)?.url
  const url = stripUrlSecrets(urlFromChain ?? fallbackUrl ?? '') || null
  const code =
    chain.map((l) => l.code).find((c) => c && c !== 'ERR_GENERIC') ??
    null
  const joined = chain.map((l) => `${l.name ?? ''} ${l.message}`).join(' ')
  const kind = classifyNetworkCode(
    code,
    chain.find((l) => l.name && l.name !== 'Error')?.name,
    joined
  )
  const httpMatch = joined.match(HTTP_STATUS_RE)
  const httpStatus = httpMatch ? Number(httpMatch[1]) : null
  let target: string | null = null
  for (const link of chain) {
    target = targetFromLink(link)
    if (target) break
  }
  if (!target && url) {
    try {
      const u = new URL(url)
      target = u.port ? `${u.hostname}:${u.port}` : u.host
    } catch {
      target = null
    }
  }

  const messages = usefulMessages(chain)
  const detail =
    messages[0] ??
    (code && target ? `${code} ${target}` : code) ??
    (target ? `connection failed ${target}` : null) ??
    (url ? `request failed ${url}` : 'network request failed')

  const logParts = [url, detail].filter((part, i, arr) => part && arr.indexOf(part) === i)
  const logLine = redactSecrets(logParts.join(' — '))

  return {
    kind,
    code,
    target,
    url,
    httpStatus,
    messages,
    dedupeKey: `${kind}|${code ?? ''}|${target ?? ''}|${url ?? ''}|${httpStatus ?? ''}`,
    logLine
  }
}

export function formatFetchErrorUserText(
  info: FetchErrorInfo,
  t: FetchErrorTranslator
): string {
  const target = info.target ?? info.url ?? ''
  switch (info.kind) {
    case 'connRefused':
      return t('errors.connRefused', { target: target || '?' })
    case 'timedOut':
      return t('errors.timedOut', { target: target || '?' })
    case 'connReset':
      return t('errors.connReset', { target: target || '?' })
    case 'dnsFailed':
      return t('errors.dnsFailed', { target: target || '?' })
    case 'aborted':
      return t('errors.aborted', { target: target || '?' })
    case 'http':
      return t('errors.httpStatus', {
        status: info.httpStatus ?? 0,
        target: target || '?'
      })
    default:
      return t('errors.networkFailed', {
        detail: redactSecrets(info.messages[0] ?? info.logLine)
      })
  }
}

/** Polling the catalog while the serve is not up is expected — not a user error. */
export function shouldSkipBackendPoll(quitting: boolean, serveStatus: string): boolean {
  if (quitting) return true
  return serveStatus !== 'running'
}

/** In-flight poll that finished after quit/stop must not surface as fetch failed. */
export function shouldSwallowPollError(quitting: boolean, serveStatus: string): boolean {
  return shouldSkipBackendPoll(quitting, serveStatus)
}

/** Connection dropped because nothing is listening or the peer vanished. */
export function isBackendLostError(err: unknown): boolean {
  const kind = inspectFetchError(err).kind
  return kind === 'connRefused' || kind === 'connReset'
}

export class ErrorLogDeduper {
  private readonly states = new Map<
    string,
    { lastLoggedAt: number; suppressed: number }
  >()

  constructor(
    private readonly windowMs = 30_000,
    private readonly now: () => number = () => Date.now()
  ) {}

  record(key: string): { shouldLog: boolean; suppressedCount: number } {
    const now = this.now()
    const prev = this.states.get(key)
    if (!prev) {
      this.states.set(key, { lastLoggedAt: now, suppressed: 0 })
      this.prune(now)
      return { shouldLog: true, suppressedCount: 0 }
    }
    if (now - prev.lastLoggedAt < this.windowMs) {
      prev.suppressed += 1
      return { shouldLog: false, suppressedCount: prev.suppressed }
    }
    const suppressed = prev.suppressed
    prev.lastLoggedAt = now
    prev.suppressed = 0
    return { shouldLog: true, suppressedCount: suppressed }
  }

  private prune(now: number): void {
    if (this.states.size < 80) return
    for (const [key, state] of this.states) {
      if (now - state.lastLoggedAt > this.windowMs * 4) this.states.delete(key)
    }
  }
}

export async function studioFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (cause) {
    throw new NetworkError(url, cause)
  }
}
