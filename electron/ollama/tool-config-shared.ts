export type ToolConfigState = 'no-config' | 'invalid' | 'missing' | 'stale' | 'current'

export type ToolConfigMismatch = 'apiBase' | 'contextLength'

export interface ToolConfigMatch {
  state: ToolConfigState
  path: string
  displayName?: string
  modelId?: string
  apiBase?: string
  contextLength?: number
  expectedApiBase?: string
  expectedContextLength?: number
  mismatches: ToolConfigMismatch[]
}

/** Ořízne `:latest` a sjednotí case — Continue/OpenCode často ukládají tag bez `:latest`. */
export function normalizeOllamaModelId(name: string): string {
  return name.trim().toLowerCase().replace(/:latest$/, '')
}

export function modelsMatch(a: string, b: string): boolean {
  return normalizeOllamaModelId(a) === normalizeOllamaModelId(b)
}

export function ensureHttpBase(host: string): string {
  const trimmed = host.trim()
  if (!trimmed) return 'http://127.0.0.1:11434'
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, '')
  return `http://${trimmed.replace(/\/$/, '')}`
}

/** OpenAI-compatible endpoint (`…/v1`) pro OpenCode. */
export function ensureOpenAiV1Base(host: string): string {
  const base = ensureHttpBase(host)
  return /\/v1$/i.test(base) ? base : `${base}/v1`
}

export function displayNameFor(model: string): string {
  const base = model.replace(/:latest$/i, '')
  return `ollama-${base}`
}

export function parseContextLength(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw)
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return Math.round(n)
  }
  return undefined
}

/** localhost ↔ 127.0.0.1, bez trailing slash, malá písmena. */
export function canonicalizeEndpoint(url?: string): string {
  if (!url?.trim()) return ''
  const trimmed = url.trim()
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const u = new URL(withProto)
    const host = u.hostname.toLowerCase() === 'localhost' ? '127.0.0.1' : u.hostname.toLowerCase()
    const port = u.port || (u.protocol === 'https:' ? '443' : '80')
    const path = u.pathname.replace(/\/$/, '').toLowerCase()
    return `${u.protocol}//${host}:${port}${path}`
  } catch {
    return trimmed.toLowerCase().replace(/\/$/, '')
  }
}

export function endpointsMatch(a?: string, b?: string): boolean {
  return canonicalizeEndpoint(a) === canonicalizeEndpoint(b)
}

function defaultOllamaEndpoints(): string[] {
  return [
    canonicalizeEndpoint('http://127.0.0.1:11434'),
    canonicalizeEndpoint('http://127.0.0.1:11434/v1')
  ]
}

export function isDefaultOllamaEndpoint(url?: string): boolean {
  const c = canonicalizeEndpoint(url)
  return c !== '' && defaultOllamaEndpoints().includes(c)
}

/** Chybějící apiBase v nástroji = výchozí localhost:11434. */
export function apiBasesEquivalent(actual?: string, expected?: string): boolean {
  if (!expected) return true
  if (!actual?.trim()) return isDefaultOllamaEndpoint(expected)
  return endpointsMatch(actual, expected)
}

export function toolMatch(partial: Omit<ToolConfigMatch, 'mismatches'> & { mismatches?: ToolConfigMismatch[] }): ToolConfigMatch {
  return { mismatches: [], ...partial }
}
