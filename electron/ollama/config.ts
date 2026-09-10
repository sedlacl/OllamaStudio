import { app } from 'electron'
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'fs'
import { dirname, join } from 'path'
import { atomicWriteJson } from '../storage/atomic-json'
import {
  isBackendId,
  type AppConfig,
  type BackendConfigMap,
  type BackendId,
  type OllamaEnvConfig,
  type TabbyConfig
} from '../../shared/backend-contract'
export type {
  AppConfig,
  AppLanguage,
  BackendConfigMap,
  OllamaEnvConfig,
  TabbyConfig
} from '../../shared/backend-contract'

const CONFIG_VERSION = 3

export const DEFAULT_TABBY_INSTALL_DIR = 'D:\\AI\\Tabby'

export const DEFAULT_TABBY_CONFIG: TabbyConfig = {
  installDir: DEFAULT_TABBY_INSTALL_DIR,
  pythonPath: '',
  configPath: '',
  host: '127.0.0.1',
  port: 5000,
  modelDir: '',
  autoStartServe: false
}

const DEFAULT_OLLAMA_ENV: OllamaEnvConfig = {
    OLLAMA_HOST: '127.0.0.1:11434',
    OLLAMA_CONTEXT_LENGTH: '131072',
    OLLAMA_KEEP_ALIVE: '30m',
    OLLAMA_MAX_LOADED_MODELS: '',
    OLLAMA_NUM_PARALLEL: '1',
    OLLAMA_FLASH_ATTENTION: '1',
    OLLAMA_KV_CACHE_TYPE: 'q8_0',
    OLLAMA_DEBUG: '1',
    OLLAMA_DEBUG_LOG_REQUESTS: '1',
    LLAMA_ARG_CTX_CHECKPOINTS: '0',
    OLLAMA_MODELS: ''
}

const DEFAULT_PROVIDERS: BackendConfigMap = {
  ollama: {
    env: { ...DEFAULT_OLLAMA_ENV },
    autoStartServe: true,
    profileDefaults: { keepAlive: '30m', numCtx: 131072 }
  },
  tabby: { ...DEFAULT_TABBY_CONFIG }
}

const DEFAULT_CONFIG: AppConfig = {
  configVersion: CONFIG_VERSION,
  activeBackend: 'ollama',
  providers: structuredClone(DEFAULT_PROVIDERS),
  ollamaEnv: { ...DEFAULT_OLLAMA_ENV },
  autoStartServe: true,
  language: 'cs',
  tabby: { ...DEFAULT_TABBY_CONFIG }
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function backupConfig(path: string): string | null {
  if (!existsSync(path)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = join(dirname(path), `config.backup.${stamp}.json`)
  copyFileSync(path, backup)
  return backup
}

export function normalizeTabby(partial?: Partial<TabbyConfig> | null): TabbyConfig {
  return {
    ...DEFAULT_TABBY_CONFIG,
    ...(partial ?? {}),
    port:
      typeof partial?.port === 'number' && Number.isFinite(partial.port) && partial.port > 0
        ? Math.round(partial.port)
        : DEFAULT_TABBY_CONFIG.port,
    host: (partial?.host ?? DEFAULT_TABBY_CONFIG.host).trim() || DEFAULT_TABBY_CONFIG.host,
    installDir:
      (partial?.installDir ?? DEFAULT_TABBY_CONFIG.installDir).trim() ||
      DEFAULT_TABBY_CONFIG.installDir
  }
}

function normalizeBackend(value: unknown): BackendId {
  return isBackendId(value) ? value : 'ollama'
}

type ParsedConfig = Partial<AppConfig> & {
  providers?: Partial<{
    ollama: Partial<BackendConfigMap['ollama']>
    tabby: Partial<TabbyConfig>
  }>
  ollamaEnv?: Partial<OllamaEnvConfig>
  tabby?: Partial<TabbyConfig>
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback
}

function normalizeConfig(parsed: ParsedConfig, preferLegacyAliases: boolean): AppConfig {
  const providerOllama = parsed.providers?.ollama
  const legacyEnv = parsed.ollamaEnv
  const envSource = preferLegacyAliases && legacyEnv ? legacyEnv : providerOllama?.env ?? legacyEnv
  const env = { ...DEFAULT_OLLAMA_ENV, ...envSource }
  const legacyContext = positiveInt(
    Number.parseInt(env.OLLAMA_CONTEXT_LENGTH, 10),
    DEFAULT_PROVIDERS.ollama.profileDefaults.numCtx
  )
  const profileDefaults = {
    keepAlive:
      providerOllama?.profileDefaults?.keepAlive?.trim() ||
      env.OLLAMA_KEEP_ALIVE.trim() ||
      DEFAULT_PROVIDERS.ollama.profileDefaults.keepAlive,
    numCtx: positiveInt(providerOllama?.profileDefaults?.numCtx, legacyContext)
  }
  const ollama = {
    env,
    autoStartServe:
      preferLegacyAliases && typeof parsed.autoStartServe === 'boolean'
        ? parsed.autoStartServe
        : typeof providerOllama?.autoStartServe === 'boolean'
          ? providerOllama.autoStartServe
          : typeof parsed.autoStartServe === 'boolean'
            ? parsed.autoStartServe
            : DEFAULT_PROVIDERS.ollama.autoStartServe,
    profileDefaults
  }
  const tabby = normalizeTabby(
    preferLegacyAliases && parsed.tabby ? parsed.tabby : parsed.providers?.tabby ?? parsed.tabby
  )
  return {
    configVersion: CONFIG_VERSION,
    activeBackend: normalizeBackend(parsed.activeBackend),
    language: parsed.language === 'en' ? 'en' : 'cs',
    providers: { ollama, tabby },
    ollamaEnv: { ...ollama.env },
    autoStartServe: ollama.autoStartServe,
    tabby: { ...tabby }
  }
}

function serializedConfig(config: AppConfig): Omit<AppConfig, 'ollamaEnv' | 'autoStartServe' | 'tabby'> {
  return {
    configVersion: CONFIG_VERSION,
    activeBackend: normalizeBackend(config.activeBackend),
    language: config.language === 'en' ? 'en' : 'cs',
    providers: structuredClone(config.providers)
  }
}

/** Idempotentní migrace na CONFIG_VERSION; před zápisem zálohuje původní soubor. */
export function migrateConfig(parsed: ParsedConfig): {
  config: AppConfig
  migrated: boolean
  backupPath: string | null
} {
  const fromVersion = parsed.configVersion ?? 0
  const migrated = fromVersion < CONFIG_VERSION || parsed.providers == null
  const config = normalizeConfig(parsed, fromVersion < CONFIG_VERSION)
  if (fromVersion < 2) config.activeBackend = 'ollama'

  let backupPath: string | null = null
  if (migrated) {
    backupPath = backupConfig(configPath())
    atomicWriteJson(configPath(), serializedConfig(config))
  }

  return { config, migrated, backupPath }
}

export function loadConfig(): AppConfig {
  const path = configPath()
  if (!existsSync(path)) {
    saveConfig(DEFAULT_CONFIG)
    return structuredClone(DEFAULT_CONFIG)
  }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as ParsedConfig
    const { config, migrated } = migrateConfig(parsed)
    if (!migrated && (parsed.configVersion ?? 0) >= CONFIG_VERSION) {
      return config
    }
    return config
  } catch {
    /* Poškozený JSON — nenačítej tiše defaulty přes starý soubor; zálohuj a zapiš default. */
    try {
      backupConfig(path)
    } catch {
      /* ignore */
    }
    saveConfig(DEFAULT_CONFIG)
    return structuredClone(DEFAULT_CONFIG)
  }
}

export function saveConfig(config: AppConfig): void {
  const normalized = normalizeConfig(config, true)
  atomicWriteJson(configPath(), serializedConfig(normalized))
}

export function getBackendSettings<I extends BackendId>(
  id: I,
  config: AppConfig = loadConfig()
): BackendConfigMap[I] {
  return structuredClone(config.providers[id])
}

export function saveBackendSettings<I extends BackendId>(
  id: I,
  patch: Partial<BackendConfigMap[I]>
): BackendConfigMap[I] {
  const config = loadConfig()
  if (id === 'ollama') {
    const current = config.providers.ollama
    const incoming = patch as Partial<BackendConfigMap['ollama']>
    config.providers.ollama = {
      ...current,
      ...incoming,
      env: { ...current.env, ...incoming.env },
      profileDefaults: { ...current.profileDefaults, ...incoming.profileDefaults }
    }
    config.ollamaEnv = { ...config.providers.ollama.env }
    config.autoStartServe = config.providers.ollama.autoStartServe
  } else {
    config.providers.tabby = normalizeTabby({
      ...config.providers.tabby,
      ...(patch as Partial<TabbyConfig>)
    })
    config.tabby = { ...config.providers.tabby }
  }
  saveConfig(normalizeConfig(config, false))
  return getBackendSettings(id)
}

export function getActiveBackend(config?: AppConfig): BackendId {
  const cfg = config ?? loadConfig()
  return normalizeBackend(cfg.activeBackend)
}

export function resolveTabbyPython(tabby: TabbyConfig): string {
  if (tabby.pythonPath.trim()) return tabby.pythonPath.trim()
  return join(tabby.installDir, 'venv', 'Scripts', 'python.exe')
}

export function resolveTabbyConfigPath(tabby: TabbyConfig): string {
  if (tabby.configPath.trim()) return tabby.configPath.trim()
  return join(tabby.installDir, 'config.yml')
}

export function resolveTabbyModelDir(tabby: TabbyConfig): string {
  if (tabby.modelDir.trim()) return tabby.modelDir.trim()
  return join(tabby.installDir, 'models')
}

export function tabbyBaseUrl(tabby?: TabbyConfig): string {
  const t = normalizeTabby(tabby ?? loadConfig().tabby)
  return `http://${t.host}:${t.port}`
}

export function buildSpawnEnv(config: AppConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(config.ollamaEnv)) {
    // Prázdné hodnoty nepřepisují process.env ani WSL fallback níže.
    if (value !== undefined && value !== '') {
      env[key] = value
    }
  }

  // WSL: znovu použít Windows modely bez ručního nastavení OLLAMA_MODELS.
  if (
    process.platform !== 'win32' &&
    !(env.OLLAMA_MODELS && env.OLLAMA_MODELS.trim()) &&
    !(config.ollamaEnv.OLLAMA_MODELS && config.ollamaEnv.OLLAMA_MODELS.trim())
  ) {
    const detected = detectWslWindowsOllamaModelsDir()
    if (detected) env.OLLAMA_MODELS = detected
  }

  return env
}

/**
 * Ve WSL bývají Windows uživatelské disky pod /mnt/<písmeno>/Users/...
 * Pokud existuje .ollama/models (manifests + blobs), použijeme ho jako OLLAMA_MODELS,
 * aby se nemusely stahovat znovu na Linuxovou stranu.
 */
export function detectWslWindowsOllamaModelsDir(): string | null {
  if (process.platform === 'win32') return null
  const mntRoot = '/mnt'
  if (!existsSync(mntRoot)) return null

  try {
    for (const drive of readdirSync(mntRoot)) {
      const usersDir = join(mntRoot, drive, 'Users')
      if (!existsSync(usersDir)) continue
      let users: string[]
      try {
        users = readdirSync(usersDir)
      } catch {
        continue
      }
      for (const user of users) {
        const modelsDir = join(usersDir, user, '.ollama', 'models')
        if (
          existsSync(join(modelsDir, 'manifests')) &&
          existsSync(join(modelsDir, 'blobs'))
        ) {
          return modelsDir
        }
      }
    }
  } catch {
    /* best effort */
  }
  return null
}

export function parseHostPort(host: string): { host: string; port: number } {
  const trimmed = host.trim() || '127.0.0.1:11434'
  if (trimmed.includes(':')) {
    const [h, p] = trimmed.split(':')
    return { host: h || '127.0.0.1', port: parseInt(p, 10) || 11434 }
  }
  return { host: trimmed, port: 11434 }
}

export { CONFIG_VERSION, DEFAULT_CONFIG }
