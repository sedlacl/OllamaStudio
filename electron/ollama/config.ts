import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

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

export interface AppConfig {
  ollamaEnv: OllamaEnvConfig
  autoStartServe: boolean
  /** UI + tray jazyk; chybí ve starších configech → cs. */
  language?: AppLanguage
  configVersion?: number
}

const CONFIG_VERSION = 1

const DEFAULT_CONFIG: AppConfig = {
  configVersion: CONFIG_VERSION,
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
  language: 'cs'
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
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
    const language =
      parsed.language === 'en' || parsed.language === 'cs'
        ? parsed.language
        : DEFAULT_CONFIG.language
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
      language,
      ollamaEnv: { ...DEFAULT_CONFIG.ollamaEnv, ...parsed.ollamaEnv }
    }

    if ((parsed.configVersion ?? 0) < CONFIG_VERSION) {
      for (const [key, value] of Object.entries(DEFAULT_CONFIG.ollamaEnv) as Array<
        [keyof OllamaEnvConfig, string]
      >) {
        if (config.ollamaEnv[key] === '') {
          config.ollamaEnv[key] = value
        }
      }
      config.configVersion = CONFIG_VERSION
      saveConfig(config)
    }

    return config
  } catch {
    return structuredClone(DEFAULT_CONFIG)
  }
}

export function saveConfig(config: AppConfig): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8')
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
