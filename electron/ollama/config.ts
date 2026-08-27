import { app } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import type { BackendId } from '../backends/types'

export interface OllamaEnvConfig {
  OLLAMA_HOST: string
  OLLAMA_CONTEXT_LENGTH: string
  OLLAMA_KEEP_ALIVE: string
  OLLAMA_MAX_LOADED_MODELS: string
  OLLAMA_NUM_PARALLEL: string
  OLLAMA_FLASH_ATTENTION: string
  OLLAMA_KV_CACHE_TYPE: string
  OLLAMA_DEBUG: string
  OLLAMA_DEBUG_LOG_REQUESTS: string
  LLAMA_ARG_CTX_CHECKPOINTS: string
  /** Adresář s blobs/manifests; prázdné = výchozí Ollama (~/.ollama/models). */
  OLLAMA_MODELS: string
}

export type AppLanguage = 'cs' | 'en'

export interface TabbyConfig {
  /** Checkout TabbyAPI (obsahuje main.py). */
  installDir: string
  /** Absolutní cesta k venv python.exe; prázdné = installDir/venv/Scripts/python.exe. */
  pythonPath: string
  /** Relativní nebo absolutní cesta k config.yml; prázdné = installDir/config.yml. */
  configPath: string
  host: string
  port: number
  /** Adresář modelů; prázdné = installDir/models. */
  modelDir: string
  autoStartServe: boolean
}

export interface AppConfig {
  ollamaEnv: OllamaEnvConfig
  autoStartServe: boolean
  /** UI + tray jazyk; chybí ve starších configech → cs. */
  language?: AppLanguage
  configVersion?: number
  /** Aktivní spravovaný backend — právě jeden. */
  activeBackend?: BackendId
  tabby?: TabbyConfig
}

const CONFIG_VERSION = 2

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

const DEFAULT_CONFIG: AppConfig = {
  configVersion: CONFIG_VERSION,
  activeBackend: 'ollama',
  ollamaEnv: {
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
  },
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

function atomicWriteJson(path: string, data: unknown): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, path)
}

function normalizeTabby(partial?: Partial<TabbyConfig> | null): TabbyConfig {
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
  return value === 'tabby' ? 'tabby' : 'ollama'
}

/** Idempotentní migrace na CONFIG_VERSION; před zápisem zálohuje. */
export function migrateConfig(parsed: Partial<AppConfig>): {
  config: AppConfig
  migrated: boolean
  backupPath: string | null
} {
  const language =
    parsed.language === 'en' || parsed.language === 'cs'
      ? parsed.language
      : DEFAULT_CONFIG.language
  const fromVersion = parsed.configVersion ?? 0
  let migrated = fromVersion < CONFIG_VERSION

  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    ...parsed,
    language,
    activeBackend: normalizeBackend(parsed.activeBackend ?? DEFAULT_CONFIG.activeBackend),
    ollamaEnv: { ...DEFAULT_CONFIG.ollamaEnv, ...parsed.ollamaEnv },
    tabby: normalizeTabby(parsed.tabby)
  }

  if (fromVersion < 1) {
    for (const [key, value] of Object.entries(DEFAULT_CONFIG.ollamaEnv) as Array<
      [keyof OllamaEnvConfig, string]
    >) {
      if (config.ollamaEnv[key] === '') {
        config.ollamaEnv[key] = value
      }
    }
    migrated = true
  }

  if (fromVersion < 2) {
    config.activeBackend = 'ollama'
    config.tabby = normalizeTabby(parsed.tabby)
    migrated = true
  }

  config.configVersion = CONFIG_VERSION

  let backupPath: string | null = null
  if (migrated) {
    backupPath = backupConfig(configPath())
    atomicWriteJson(configPath(), config)
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
    const parsed = JSON.parse(raw) as Partial<AppConfig>
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
  const normalized: AppConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    activeBackend: normalizeBackend(config.activeBackend),
    ollamaEnv: { ...DEFAULT_CONFIG.ollamaEnv, ...config.ollamaEnv },
    tabby: normalizeTabby(config.tabby),
    configVersion: CONFIG_VERSION
  }
  atomicWriteJson(configPath(), normalized)
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
