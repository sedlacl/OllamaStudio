/** Centrální redakce tajemství — idempotentní, bez globálního maskování hex digestů. */

export const REDACTION_MARKER = '[REDACTED]'

const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
const HF_TOKEN_RE = /\bhf_[A-Za-z0-9._-]+\b/g
const BEARER_RE = /Bearer\s+\S+/gi

const CREDENTIAL_LABEL_RE =
  /((?:^|[\s:])((?:api[_-]?key|admin[_-]?key|access[_-]?token|hf[_-]?token|password|secret|token))\s*[:=]\s*)(\S+)/gi

const AUTH_HEADER_RE = /((?:^|\s)(?:Authorization|x-api-key|x-admin-key)\s*[:=]\s*)(\S+)/gi

const URL_QUERY_RE =
  /([?&](?:token|key|api[_-]?key|access[_-]?token|authorization|admin[_-]?key|hf[_-]?token|password|secret)=)([^&\s#]+)/gi

/** JSON credential values — `"token": "value"` */
const JSON_QUOTED_CREDENTIAL_RE =
  /("(?:token|api[_-]?key|admin[_-]?key|access[_-]?token|hf[_-]?token|password|secret|authorization)"\s*:\s*")([^"]+)(")/gi

/** YAML double/single-quoted credential values (unquoted key). */
const YAML_QUOTED_CREDENTIAL_RE =
  /((?:^|[\s,])(?:api[_-]?key|admin[_-]?key|access[_-]?token|hf[_-]?token|password|secret|token)\s*:\s*)(["'])([^"']+)\2/gim

/** YAML credential with single-quoted key and value — 'api_key': 'secret'. */
const YAML_SINGLE_QUOTED_KEY_CREDENTIAL_RE =
  /((?:^|[\s,])'(?:api[_-]?key|admin[_-]?key|access[_-]?token|hf[_-]?token|password|secret|token)'\s*:\s*')([^']*)(')/gim

/** Prefixované tokeny mimo hf_ (např. sk- pro OpenAI) — jen jednoznačné prefixy. */
const PREFIX_TOKEN_RE = /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g

const SENSITIVE_QUERY_KEY =
  /^(token|key|api[_-]?key|access[_-]?token|auth|authorization|password|secret|admin[_-]?key|hf[_-]?token)$/i

interface RegistryEntry {
  value: string
  refs: number
}

const registry = new Map<string, RegistryEntry>()
const secretResanitizeListeners = new Set<() => void>()

let sortedKnown: string[] = []
let credentialFailClosed = false

/** Dočasně přísnější redakce během rotace auth souboru (před stabilizačním re-read). */
export function setCredentialFailClosed(enabled: boolean): void {
  if (credentialFailClosed === enabled) return
  credentialFailClosed = enabled
  notifyResanitize()
}

export function isCredentialFailClosed(): boolean {
  return credentialFailClosed
}

function rebuildSortedKnown(): void {
  sortedKnown = [...registry.values()]
    .map((e) => e.value)
    .filter((v) => v.length > 0)
    .sort((a, b) => b.length - a.length)
}

function notifyResanitize(): void {
  for (const listener of secretResanitizeListeners) listener()
}

/** Registruje známé tajemství; vrací handle pro odregistraci. */
export function registerSecret(value: string): () => void {
  const trimmed = value.trim()
  if (!trimmed) return () => undefined
  const existing = registry.get(trimmed)
  if (existing) {
    existing.refs += 1
  } else {
    registry.set(trimmed, { value: trimmed, refs: 1 })
    rebuildSortedKnown()
    notifyResanitize()
  }
  let released = false
  return () => {
    if (released) return
    released = true
    unregisterSecret(trimmed)
  }
}

/** Registruje více tajemství najednou; vrací jeden release handle. */
export function registerSecrets(values: Iterable<string>): () => void {
  const releases = [...values].map((v) => registerSecret(v))
  return () => {
    for (const release of releases) release()
  }
}

export function unregisterSecret(value: string): void {
  const trimmed = value.trim()
  if (!trimmed) return
  const existing = registry.get(trimmed)
  if (!existing) return
  existing.refs -= 1
  if (existing.refs <= 0) {
    registry.delete(trimmed)
    rebuildSortedKnown()
    notifyResanitize()
  }
}

/** Po registraci nového tajemství znovu sanitizuj existující stavy (RAM). */
export function onSecretsResanitize(listener: () => void): () => void {
  secretResanitizeListeners.add(listener)
  return () => secretResanitizeListeners.delete(listener)
}

function redactKnownSecrets(text: string): string {
  let out = text
  for (const secret of sortedKnown) {
    if (!secret || !out.includes(secret)) continue
    out = out.split(secret).join(REDACTION_MARKER)
  }
  return out
}

function decodePercentSafe(segment: string): string {
  try {
    return decodeURIComponent(segment.replace(/\+/g, '%20'))
  } catch {
    return segment
  }
}

function redactUrlQueryParams(text: string): string {
  return text.replace(
    /([?&]([^=&\s#]+)=)([^&\s#]*)/gi,
    (match, prefix: string, rawKey: string, rawValue: string) => {
      const decodedKey = decodePercentSafe(rawKey)
      if (!SENSITIVE_QUERY_KEY.test(decodedKey)) return match
      if (!rawValue || rawValue === '***') return `${prefix}***`
      const decodedValue = decodePercentSafe(rawValue)
      const redactedValue = sanitizeSecrets(decodedValue)
      if (redactedValue === '***' || redactedValue === REDACTION_MARKER) {
        return `${prefix}***`
      }
      try {
        return `${prefix}${encodeURIComponent(redactedValue)}`
      } catch {
        return `${prefix}***`
      }
    }
  )
}

function redactContextPatterns(text: string): string {
  let out = text
    .replace(BEARER_RE, 'Bearer ***')
    .replace(HF_TOKEN_RE, 'hf_***')
    .replace(JWT_RE, REDACTION_MARKER)
    .replace(PREFIX_TOKEN_RE, REDACTION_MARKER)
    .replace(
      JSON_QUOTED_CREDENTIAL_RE,
      (_m, prefix: string, _value: string, suffix: string) => `${prefix}***${suffix}`
    )
    .replace(
      YAML_QUOTED_CREDENTIAL_RE,
      (_m, prefix: string, quote: string) => `${prefix}${quote}***${quote}`
    )
    .replace(
      YAML_SINGLE_QUOTED_KEY_CREDENTIAL_RE,
      (_m, prefix: string, _value: string, suffix: string) => `${prefix}***${suffix}`
    )
    .replace(CREDENTIAL_LABEL_RE, (_m, prefix: string) => `${prefix}***`)
    .replace(AUTH_HEADER_RE, (_m, prefix: string) => `${prefix}***`)
    .replace(URL_QUERY_RE, '$1***')
  out = redactUrlQueryParams(out)
  return out
}

/**
 * Sanitizuje text — idempotentní. Nezaměňuje libovolné 32/64 hex řetězce
 * (SHA, commit hash, model ID).
 */
function redactTabbyKeyLineInline(line: string): string {
  const sameLinePatterns = [
    /(Your API key is:\s*)((?:\x1b\[[0-9;]*[A-Za-z]|\s)*)(.+)$/i,
    /(Your admin key is:\s*)((?:\x1b\[[0-9;]*[A-Za-z]|\s)*)(.+)$/i
  ]
  let out = line
  for (const pattern of sameLinePatterns) {
    out = out.replace(pattern, (_m, label: string, _gap: string, value: string) =>
      value.trim() ? `${label}${REDACTION_MARKER}` : label
    )
  }
  return redactContextPatterns(out)
}

function redactFailClosedCredentialLines(text: string): string {
  if (!credentialFailClosed) return text
  const lines = text.split('\n')
  let pendingLabel = false
  const out: string[] = []
  for (const line of lines) {
    if (pendingLabel) {
      pendingLabel = false
      const trimmed = line.trim()
      out.push(trimmed ? REDACTION_MARKER : '')
      continue
    }
    if (isTabbySensitiveLabelLine(line)) {
      pendingLabel = true
      out.push(redactTabbyKeyLineInline(line))
      continue
    }
    out.push(redactContextPatterns(line))
  }
  return out.join('\n')
}

export function sanitizeSecrets(text: string): string {
  if (!text) return text
  let out = credentialFailClosed ? redactFailClosedCredentialLines(text) : text
  out = redactKnownSecrets(out)
  out = redactContextPatterns(out)
  // Druhý průchod pro případ, že kontextové vzory odhalily nové shody se známými hodnotami.
  out = redactKnownSecrets(out)
  // Idempotence — normalizuj opakované markery po známých hodnotách.
  if (sortedKnown.length > 0) {
    for (const secret of sortedKnown) {
      if (secret === REDACTION_MARKER) continue
    }
  }
  return out
}

/** Sanitizace URL — alias pro konzistentní použití v chybách a logu. */
export function sanitizeUrl(url: string): string {
  if (!url) return url
  let out = redactUrlQueryParams(url)
  out = sanitizeSecrets(out)
  return out
}

/** Sanitizace chybové zprávy. */
export function sanitizeErrorMessage(message: string): string {
  return sanitizeSecrets(message)
}

/** Vynutí redakci citlivého labelu Tabby na stejném řádku (ANSI reset/timestamp neblokuje hodnotu). */
export function sanitizeTabbyKeyLine(line: string): string {
  const sameLinePatterns = [
    /(Your API key is:\s*)((?:\x1b\[[0-9;]*[A-Za-z]|\s)*)(.+)$/i,
    /(Your admin key is:\s*)((?:\x1b\[[0-9;]*[A-Za-z]|\s)*)(.+)$/i
  ]
  let out = line
  for (const pattern of sameLinePatterns) {
    out = out.replace(pattern, (_m, label: string, _gap: string, value: string) =>
      value.trim() ? `${label}${REDACTION_MARKER}` : label
    )
  }
  return sanitizeSecrets(out)
}

/** Label bez hodnoty — další neprázdný řádek stejného streamu je citlivý. */
export function isTabbySensitiveLabelLine(line: string): boolean {
  return /^.*Your (?:API|admin) key is:\s*$/i.test(line.trim())
}

/** Test-only reset registry. */
export function _resetSecretRegistryForTests(): void {
  registry.clear()
  sortedKnown = []
  credentialFailClosed = false
}
