import {
  existsSync,
  readFileSync,
  statSync,
  unwatchFile,
  watch,
  watchFile,
  type FSWatcher
} from 'fs'
import { dirname, join } from 'path'
import { parse as parseYaml } from 'yaml'
import {
  loadConfig,
  resolveTabbyConfigPath,
  type TabbyConfig
} from '../ollama/config'
import { registerSecrets, setCredentialFailClosed } from '../security/secret-redactor'

export interface TabbyAuthKeys {
  apiKeys: string[]
  adminKey: string | null
  disableAuth: boolean
  path: string
  mtimeMs: number | null
}

let cached: TabbyAuthKeys | null = null
let watchingPath: string | null = null
let registeredRelease: (() => void) | null = null
let dirWatcher: FSWatcher | null = null
let missingPoll: ReturnType<typeof setInterval> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

const STABILIZE_MS = 300

function tokensPath(tabby?: TabbyConfig): string {
  const cfg = tabby ?? loadConfig().tabby ?? undefined
  const installDir = cfg?.installDir?.trim() || 'D:\\AI\\Tabby'
  return join(installDir, 'api_tokens.yml')
}

function readDisableAuth(tabby?: TabbyConfig): boolean {
  try {
    const path = resolveTabbyConfigPath(
      tabby ??
        loadConfig().tabby ?? {
          installDir: 'D:\\AI\\Tabby',
          pythonPath: '',
          configPath: '',
          host: '127.0.0.1',
          port: 5000,
          modelDir: '',
          autoStartServe: false
        }
    )
    if (!existsSync(path)) return false
    const raw = readFileSync(path, 'utf-8')
    return /^\s*disable_auth\s*:\s*true\b/im.test(raw)
  } catch {
    return false
  }
}

function parseApiKeys(raw: unknown): string[] {
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()]
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
  }
  return []
}

export function readTabbyAuth(tabby?: TabbyConfig): TabbyAuthKeys {
  const path = tokensPath(tabby)
  const disableAuth = readDisableAuth(tabby)
  if (!existsSync(path)) {
    cached = {
      apiKeys: [],
      adminKey: null,
      disableAuth,
      path,
      mtimeMs: null
    }
    return cached
  }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = parseYaml(raw) as Record<string, unknown> | null
    const apiKeys = parseApiKeys(parsed?.api_key)
    const adminKey =
      typeof parsed?.admin_key === 'string' && parsed.admin_key.trim()
        ? parsed.admin_key.trim()
        : null
    const stat = statSync(path)
    cached = {
      apiKeys,
      adminKey,
      disableAuth,
      path,
      mtimeMs: stat.mtimeMs
    }
    return cached
  } catch {
    cached = {
      apiKeys: [],
      adminKey: null,
      disableAuth,
      path,
      mtimeMs: null
    }
    return cached
  }
}

/** Načte klíče a zaregistruje je pro redakci v logu/IPC. Vrací release handle. */
export function registerTabbyAuthSecrets(tabby?: TabbyConfig): () => void {
  const auth = readTabbyAuth(tabby)
  const secrets = [...auth.apiKeys]
  if (auth.adminKey) secrets.push(auth.adminKey)
  const nextRelease = registerSecrets(secrets)
  registeredRelease?.()
  registeredRelease = nextRelease
  return registeredRelease
}

export function releaseTabbyAuthSecrets(): void {
  registeredRelease?.()
  registeredRelease = null
}

export function getTabbyAuthFingerprint(tabby?: TabbyConfig): {
  path: string
  hasApiKey: boolean
  hasAdminKey: boolean
  disableAuth: boolean
  apiKeyCount: number
} {
  const auth = readTabbyAuth(tabby)
  return {
    path: auth.path,
    hasApiKey: auth.apiKeys.length > 0 || auth.disableAuth,
    hasAdminKey: Boolean(auth.adminKey) || auth.disableAuth,
    disableAuth: auth.disableAuth,
    apiKeyCount: auth.apiKeys.length
  }
}

/**
 * Hlavičky pro admin endpointy. Nikdy neposílat do rendereru.
 */
export function adminAuthHeaders(tabby?: TabbyConfig): Record<string, string> {
  const auth = readTabbyAuth(tabby)
  if (auth.disableAuth) return {}
  const headers: Record<string, string> = {}
  const apiKey = auth.apiKeys[0] ?? auth.adminKey
  if (apiKey) headers['x-api-key'] = apiKey
  if (auth.adminKey) headers['x-admin-key'] = auth.adminKey
  return headers
}

/** API header pro inference; admin klíč je platný fallback. */
export function apiAuthHeaders(tabby?: TabbyConfig): Record<string, string> {
  const auth = readTabbyAuth(tabby)
  if (auth.disableAuth) return {}
  const apiKey = auth.apiKeys[0] ?? auth.adminKey
  return apiKey ? { 'x-api-key': apiKey } : {}
}

function stopWatchingAuth(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  setCredentialFailClosed(false)
  if (missingPoll) {
    clearInterval(missingPoll)
    missingPoll = null
  }
  if (dirWatcher) {
    try {
      dirWatcher.close()
    } catch {
      /* ignore */
    }
    dirWatcher = null
  }
  if (watchingPath) {
    try {
      unwatchFile(watchingPath)
    } catch {
      /* ignore */
    }
    watchingPath = null
  }
}

function ensureFileWatch(path: string, fire: () => void): void {
  if (watchingPath === path) return
  if (watchingPath) {
    try {
      unwatchFile(watchingPath)
    } catch {
      /* ignore */
    }
  }
  watchingPath = path
  watchFile(path, { interval: 750 }, fire)
}

function stopMissingPoll(): void {
  if (missingPoll) {
    clearInterval(missingPoll)
    missingPoll = null
  }
}

function onTokensFileEvent(tabby: TabbyConfig | undefined, onChange: () => void): void {
  setCredentialFailClosed(true)
  cached = null
  registerTabbyAuthSecrets(tabby)
  onChange()

  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    cached = null
    registerTabbyAuthSecrets(tabby)
    setCredentialFailClosed(false)
    onChange()
  }, STABILIZE_MS)
}

/**
 * Sleduje api_tokens.yml včetně vytvoření souboru.
 * Při fs eventu okamžitě fail-closed + sync registrace; debounce jen pro stabilizační re-read.
 * Nové klíče se registrují dřív, než se uvolní staré (viz registerTabbyAuthSecrets).
 */
export function watchTabbyAuth(
  onChange: () => void,
  tabby?: TabbyConfig
): () => void {
  stopWatchingAuth()
  const path = tokensPath(tabby)
  const dir = dirname(path)
  const fileName = 'api_tokens.yml'

  const fire = (): void => onTokensFileEvent(tabby, onChange)

  try {
    dirWatcher = watch(dir, (_, filename) => {
      if (!filename) {
        if (existsSync(path)) {
          ensureFileWatch(path, fire)
          stopMissingPoll()
        }
        fire()
        return
      }
      const base = String(filename).replace(/\\/g, '/').split('/').pop() ?? ''
      if (base === fileName || base.startsWith(`${fileName}.`)) {
        if (existsSync(path)) {
          ensureFileWatch(path, fire)
          stopMissingPoll()
        } else if (watchingPath) {
          try {
            unwatchFile(watchingPath)
          } catch {
            /* ignore */
          }
          watchingPath = null
        }
        fire()
      }
    })
  } catch {
    dirWatcher = null
  }

  if (existsSync(path)) {
    ensureFileWatch(path, fire)
  } else {
    missingPoll = setInterval(() => {
      if (existsSync(path)) {
        ensureFileWatch(path, fire)
        stopMissingPoll()
        fire()
      }
    }, 1000)
  }

  return () => stopWatchingAuth()
}

/** @deprecated Prefer apiKeys */
export function legacyPrimaryApiKey(tabby?: TabbyConfig): string | null {
  const auth = readTabbyAuth(tabby)
  return auth.apiKeys[0] ?? auth.adminKey
}
