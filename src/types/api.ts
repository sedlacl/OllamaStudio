/// <reference types="vite/client" />

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

export interface ModelLoadOptions {
  keepAlive: string
  numCtx?: number
  numBatch?: number
  numGpu?: number
  numThread?: number
  useMmap?: boolean
  useMlock?: boolean
  ropeFrequencyBase?: number
  ropeFrequencyScale?: number
}

export interface ServeState {
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  pid: number | null
  spawnTime: number | null
  binaryPath: string | null
  error: string | null
  portConflict: boolean
}

export interface ModelTag {
  name: string
  model: string
  modified_at: string
  size: number
  digest: string
  details?: {
    format?: string
    family?: string
    parameter_size?: string
    quantization_level?: string
  }
}

export interface RunningModelDetails {
  parent_model?: string
  format?: string
  family?: string
  families?: string[]
  parameter_size?: string
  quantization_level?: string
}

export interface RunningModel {
  name: string
  model: string
  size: number
  size_vram?: number
  digest: string
  expires_at: string
  context_length?: number
  details?: RunningModelDetails
}

export interface ModelShow {
  modelfile?: string
  parameters?: string
  template?: string
  details?: Record<string, unknown>
  model_info?: Record<string, unknown>
  capabilities?: string[]
}

export interface RecordedLoadOptions {
  modelName: string
  options: ModelLoadOptions
  recordedAt: number
}

export interface PullProgress {
  status: string
  digest?: string
  total?: number
  completed?: number
}

export interface LogEntry {
  id: number
  timestamp: number
  stream: 'stdout' | 'stderr'
  text: string
  level: 'info' | 'error' | 'warn' | 'debug'
  category: 'general' | 'error' | 'load' | 'unload' | 'request'
  parsed?: {
    durationMs?: number
    promptTokensPerSec?: number
    generationTokensPerSec?: number
    isLoad?: boolean
    isUnload?: boolean
    isError?: boolean
    isRequest?: boolean
  }
}

export type ActiveRequestPhase =
  | 'prompt_processing'
  | 'generation'
  | 'caching'
  | 'done'
  | 'unknown'

export interface ActiveRequest {
  taskId: number
  slotId: number | null
  phase: ActiveRequestPhase
  progressPercent: number | null
  nTokens: number | null
  elapsedSeconds: number | null
  tokensPerSec: number | null
  firstSeenAt: number
  updatedAt: number
  status: 'active' | 'completed'
}

export interface DashboardData {
  gpu: {
    name: string
    memoryUsedMb: number
    memoryTotalMb: number
    utilizationPercent: number | null
  } | null
  vramFallbackMb: number | null
  loadedModels: Array<{ name: string; sizeVram: number }>
  memory: { workingSetMb: number; pid: number | null }
  activeRequests: number | null
  activeRequestDetails: ActiveRequest[]
  tokensPerSec: number | null
  uptimeSeconds: number | null
  serveStatus: string
  version: string | null
  loadedCount: number
  connection: string
}

export interface Api {
  getServeStatus: () => Promise<ServeState>
  getDashboard: () => Promise<DashboardData>
  getModelsTags: () => Promise<ModelTag[]>
  getModelsPs: () => Promise<RunningModel[]>
  modelShow: (name: string) => Promise<ModelShow>
  modelLoad: (name: string, options?: ModelLoadOptions) => Promise<void>
  modelUnload: (name: string) => Promise<void>
  modelDelete: (name: string) => Promise<void>
  modelCopy: (source: string, destination: string) => Promise<void>
  modelPull: (name: string) => Promise<{ ok: boolean; error?: string }>
  getModelLoadOptions: (name: string) => Promise<RecordedLoadOptions | null>
  onPullProgress: (cb: (data: { name: string; progress: PullProgress }) => void) => () => void
  getServerConfig: () => Promise<AppConfig>
  saveServerConfigAndRestart: (config: AppConfig) => Promise<ServeState>
  startServer: (forceKillConflict?: boolean) => Promise<ServeState>
  stopServer: () => Promise<ServeState>
  restartServer: (forceKillConflict?: boolean) => Promise<ServeState>
  getLogs: (limit?: number) => Promise<LogEntry[]>
  clearLogs: () => Promise<boolean>
  subscribeLogs: (cb: (entry: LogEntry) => void) => () => void
  detectOllamaBinary: () => Promise<string | null>
}

declare global {
  interface Window {
    ollamaStudio: Api
  }
}

export function api(): Api {
  return window.ollamaStudio
}
