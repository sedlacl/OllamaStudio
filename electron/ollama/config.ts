import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
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
}

export interface AppConfig {
  ollamaEnv: OllamaEnvConfig
  autoStartServe: boolean
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
    LLAMA_ARG_CTX_CHECKPOINTS: '0'
  },
  autoStartServe: true
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
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
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
    if (value !== undefined && value !== '') {
      env[key] = value
    }
  }
  return env
}

export function parseHostPort(host: string): { host: string; port: number } {
  const trimmed = host.trim() || '127.0.0.1:11434'
  if (trimmed.includes(':')) {
    const [h, p] = trimmed.split(':')
    return { host: h || '127.0.0.1', port: parseInt(p, 10) || 11434 }
  }
  return { host: trimmed, port: 11434 }
}
