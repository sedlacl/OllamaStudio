import { existsSync, readFileSync, statSync, watchFile, unwatchFile } from 'fs'
import { join } from 'path'
import {
  loadConfig,
  resolveTabbyConfigPath,
  type TabbyConfig
} from '../ollama/config'

export interface TabbyAuthKeys {
  apiKey: string | null
  adminKey: string | null
  disableAuth: boolean
  path: string
  mtimeMs: number | null
}

let cached: TabbyAuthKeys | null = null
let watchingPath: string | null = null

function parseYamlSimple(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = trimmed.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (value === 'true') out[key] = true
    else if (value === 'false') out[key] = false
    else if (value === '' || value === 'null' || value === '~') out[key] = null
    else out[key] = value
  }
  return out
}

function tokensPath(tabby?: TabbyConfig): string {
  const cfg = tabby ?? loadConfig().tabby ?? undefined
  const installDir = cfg?.installDir?.trim() || 'D:\\AI\\Tabby'
  return join(installDir, 'api_tokens.yml')
}

function readDisableAuth(tabby?: TabbyConfig): boolean {
  try {
    const path = resolveTabbyConfigPath(
      tabby ?? loadConfig().tabby ?? { installDir: 'D:\\AI\\Tabby', pythonPath: '', configPath: '', host: '127.0.0.1', port: 5000, modelDir: '', autoStartServe: false }
    )
    if (!existsSync(path)) return false
    const raw = readFileSync(path, 'utf-8')
    return /^\s*disable_auth\s*:\s*true\b/im.test(raw)
  } catch {
    return false
  }
}

export function readTabbyAuth(tabby?: TabbyConfig): TabbyAuthKeys {
  const path = tokensPath(tabby)
  const disableAuth = readDisableAuth(tabby)
  if (!existsSync(path)) {
    cached = {
      apiKey: null,
      adminKey: null,
      disableAuth,
      path,
      mtimeMs: null
    }
    return cached
  }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = parseYamlSimple(raw)
    const apiKey =
      typeof parsed.api_key === 'string' && parsed.api_key.trim()
        ? parsed.api_key.trim()
        : null
    const adminKey =
      typeof parsed.admin_key === 'string' && parsed.admin_key.trim()
        ? parsed.admin_key.trim()
        : null
    const stat = statSync(path)
    cached = {
      apiKey,
      adminKey,
      disableAuth,
      path,
      mtimeMs: stat.mtimeMs
    }
    return cached
  } catch {
    cached = {
      apiKey: null,
      adminKey: null,
      disableAuth,
      path,
      mtimeMs: null
    }
    return cached
  }
}

export function getTabbyAuthFingerprint(tabby?: TabbyConfig): {
  path: string
  hasApiKey: boolean
  hasAdminKey: boolean
  disableAuth: boolean
} {
  const auth = readTabbyAuth(tabby)
  return {
    path: auth.path,
    hasApiKey: Boolean(auth.apiKey) || auth.disableAuth,
    hasAdminKey: Boolean(auth.adminKey) || auth.disableAuth,
    disableAuth: auth.disableAuth
  }
}

/**
 * Hlavičky pro admin endpointy. Nikdy neposílat do rendereru.
 *
 * TabbyAPI kontroluje admin route dvakrát: nejdřív `check_api_key`, teprve pak
 * `check_admin_key`. Samotný `x-admin-key` proto vrací 401 „Please provide an
 * API key“ — je nutné poslat obě hlavičky. Admin klíč platí i jako API klíč,
 * takže při chybějícím `api_key` slouží jako fallback.
 */
export function adminAuthHeaders(tabby?: TabbyConfig): Record<string, string> {
  const auth = readTabbyAuth(tabby)
  if (auth.disableAuth) return {}
  const headers: Record<string, string> = {}
  const apiKey = auth.apiKey ?? auth.adminKey
  if (apiKey) headers['x-api-key'] = apiKey
  if (auth.adminKey) headers['x-admin-key'] = auth.adminKey
  return headers
}

/** API header pro inference; admin klíč je platný fallback. */
export function apiAuthHeaders(tabby?: TabbyConfig): Record<string, string> {
  const auth = readTabbyAuth(tabby)
  if (auth.disableAuth) return {}
  const apiKey = auth.apiKey ?? auth.adminKey
  return apiKey ? { 'x-api-key': apiKey } : {}
}

export function watchTabbyAuth(
  onChange: () => void,
  tabby?: TabbyConfig
): () => void {
  const path = tokensPath(tabby)
  if (watchingPath && watchingPath !== path) {
    unwatchFile(watchingPath)
    watchingPath = null
  }
  if (!existsSync(path)) {
    return () => undefined
  }
  watchingPath = path
  watchFile(path, { interval: 2000 }, () => {
    cached = null
    onChange()
  })
  return () => {
    if (watchingPath) {
      unwatchFile(watchingPath)
      watchingPath = null
    }
  }
}
