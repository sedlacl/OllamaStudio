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
  /** Adresář modelů (blobs/manifests); prázdné = výchozí Ollama / WSL autodetekce. */
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

export interface ModelSpeedTestResult {
  model: string
  prompt: string
  response: string
  /** Čas do prvního tokenu měřeného běhu — model už je načtený a zahřátý. */
  ttftMs: number
  tokensPerSecond: number
  generatedTokens: number
  /** Reasoning výstup u modelů s thinking parserem; `response` bývá u nich prázdné. */
  thinking: string
  promptTokensPerSecond: number
  promptTokens: number
  promptEvalMs: number
  totalMs: number
  /** Doba načtení modelu do paměti; 0 = model už běžel. */
  loadMs: number
  /** false = model se kvůli testu musel načíst (načtení se do TTFT nepočítá). */
  wasLoaded: boolean
}

export interface OllamaUpdateInfo {
  current: string | null
  latest: string | null
  updateAvailable: boolean
  releaseUrl: string
  checkedAt: number
  error?: string
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

export type RequestHistoryResult = 'done' | 'stale' | 'error'

export type RequestKind = 'chat' | 'generate' | 'embed' | 'load'

export interface ActiveRequest {
  taskId: number
  slotId: number | null
  kind: RequestKind | null
  model: string | null
  phase: ActiveRequestPhase
  progressPercent: number | null
  nTokens: number | null
  promptTokens: number | null
  generationTokens: number | null
  elapsedSeconds: number | null
  tokensPerSec: number | null
  promptTokensPerSec: number | null
  generationTokensPerSec: number | null
  firstSeenAt: number
  updatedAt: number
  status: 'active' | 'completed'
  completionReason: string | null
}

export interface RequestHistoryItem {
  taskId: number
  slotId: number | null
  kind: RequestKind | null
  model: string | null
  phase: ActiveRequestPhase | null
  result: RequestHistoryResult
  completionReason: string | null
  progressPercent: number | null
  promptTokens: number | null
  generationTokens: number | null
  elapsedSeconds: number | null
  promptTokensPerSec: number | null
  generationTokensPerSec: number | null
  startedAt: number
  completedAt: number
}

export interface DashboardData {
  gpu: {
    /** index z nvidia-smi; null u adaptérů, které nvidia-smi nevidí */
    index?: number | null
    name: string
    memoryUsedMb: number
    memoryTotalMb: number
    utilizationPercent: number | null
  } | null
  vramFallbackMb: number | null
  loadedModels: Array<{ name: string; sizeVram: number; size: number }>
  memory: { workingSetMb: number; pid: number | null }
  activeRequests: number | null
  activeRequestDetails: ActiveRequest[]
  requestHistory: RequestHistoryItem[]
  tokensPerSec: number | null
  uptimeSeconds: number | null
  serveStatus: string
  version: string | null
  loadedCount: number
  connection: string
}

export type GpuMemorySource = 'nvidia-smi' | 'perf-counter' | 'process-list'

export interface GpuProcessInfo {
  pid: number
  processName: string
  /** rezidentní paměť ve VRAM adaptéru; null = hodnota není dostupná */
  gpuMemoryMb: number | null
  source: GpuMemorySource
  /** adaptér, na kterém paměť leží; null = zdroj GPU nerozlišuje */
  adapterKey: string | null
  adapterName: string | null
}

export interface GpuAdapterInfo {
  key: string
  name: string
  dedicatedTotalMb: number | null
  dedicatedUsedMb: number | null
  sharedUsedMb: number | null
  nvidia: {
    index: number | null
    name: string
    memoryUsedMb: number
    memoryTotalMb: number
    utilizationPercent: number | null
  } | null
}

export interface ResourceUsageData {
  gpu: DashboardData['gpu']
  adapters: GpuAdapterInfo[]
  gpuAvailable: boolean
  /** false, když per-proces VRAM neumí ani nvidia-smi, ani výkonnostní čítače */
  perProcessVramAvailable: boolean
  perProcessSource: GpuMemorySource | null
  perProcessVramTotalMb: number | null
  gpuProcesses: GpuProcessInfo[]
  ollamaProcesses: GpuProcessInfo[]
  vramFallbackMb: number | null
  loadedModels: Array<{ name: string; sizeVram: number; size: number }>
  serveMemory: { workingSetMb: number; pid: number | null }
  systemMemory: { totalMb: number; freeMb: number; usedMb: number }
  cpu: { model: string; cores: number; usagePercent: number | null }
  serveStatus: string
}

export type ModelLoadStatus = 'loading' | 'success' | 'error'

export interface ModelLoadState {
  name: string
  status: ModelLoadStatus
  error?: string
  startedAt: number
}

export interface ModelLoadResult {
  ok: boolean
  error?: string
}

export type PresetKind = 'load' | 'serve'

/**
 * Volba `use_mmap` při načtení. `auto` znamená hodnotu vůbec neposlat — Ollama si
 * mmap vybere sama (na Windows s CUDA ho vypíná) a runner tak odpovídá tomu, co
 * dostane i klient, který options neposílá.
 */
export type MmapPreference = 'auto' | 'on' | 'off'

export interface LoadPresetData {
  keepInMemory: boolean
  ttl: string
  numCtx: string
  numBatch: string
  numGpu: string
  numThread: string
  /** Presety z verzí do 1.3.2 mají boolean. */
  useMmap: MmapPreference | boolean
  useMlock: boolean
  ropeBase: string
  ropeScale: string
}

export interface ServePresetData {
  ollamaEnv: OllamaEnvConfig
  autoStartServe: boolean
}

export type PresetDataMap = {
  load: LoadPresetData
  serve: ServePresetData
}

export interface Preset<K extends PresetKind = PresetKind> {
  id: string
  name: string
  kind: K
  updatedAt: number
  data: PresetDataMap[K]
}

export interface ContinueModelEntry {
  name: string
  model: string
  provider: string
  apiBase?: string
  contextLength?: number
  roles?: string[]
}

export interface ContinueConfigStatus {
  path: string
  exists: boolean
  invalid: boolean
  models: ContinueModelEntry[]
}

export interface OpenCodeModelEntry {
  model: string
  name: string
  apiBase?: string
  contextLength?: number
  outputLength?: number
  providerId: string
}

export type ToolConfigState = 'no-config' | 'invalid' | 'missing' | 'stale' | 'current'

export type ToolConfigMismatch = 'apiBase' | 'contextLength' | 'outputLength'

export interface ToolConfigMatch {
  state: ToolConfigState
  path: string
  displayName?: string
  modelId?: string
  apiBase?: string
  contextLength?: number
  outputLength?: number
  expectedApiBase?: string
  expectedContextLength?: number
  expectedOutputLength?: number
  mismatches: ToolConfigMismatch[]
}

export interface ToolFileStatus {
  path: string
  exists: boolean
  invalid: boolean
  byModel: Record<string, ToolConfigMatch>
}

export interface IntegrationsStatus {
  continue: ToolFileStatus
  opencode: ToolFileStatus
}

export interface Api {
  getServeStatus: () => Promise<ServeState>
  getAppVersion: () => Promise<string>
  getDashboard: () => Promise<DashboardData>
  getResourceUsage: () => Promise<ResourceUsageData>
  getModelsTags: () => Promise<ModelTag[]>
  getModelsPs: () => Promise<RunningModel[]>
  modelShow: (name: string) => Promise<ModelShow>
  modelLoad: (name: string, options?: ModelLoadOptions) => Promise<ModelLoadResult>
  modelUnload: (name: string) => Promise<void>
  modelTestSpeed: (name: string) => Promise<ModelSpeedTestResult>
  getSpeedTests: () => Promise<Record<string, ModelSpeedTestResult>>
  /** Výsledek testu se změnil (ruční test, automatický po načtení, unload modelu). */
  onSpeedTestsChanged: (cb: () => void) => () => void
  checkOllamaUpdate: (force?: boolean) => Promise<OllamaUpdateInfo>
  openExternal: (url: string) => Promise<void>
  modelDelete: (name: string) => Promise<void>
  modelCopy: (source: string, destination: string) => Promise<void>
  modelPull: (name: string) => Promise<{ ok: boolean; error?: string }>
  getModelLoadOptions: (name: string) => Promise<RecordedLoadOptions | null>
  getModelLoadStatus: () => Promise<ModelLoadState[]>
  onModelLoadStatus: (cb: (state: ModelLoadState) => void) => () => void
  onPullProgress: (cb: (data: { name: string; progress: PullProgress }) => void) => () => void
  getServerConfig: () => Promise<AppConfig>
  saveServerConfigAndRestart: (config: AppConfig) => Promise<ServeState>
  startServer: (forceKillConflict?: boolean) => Promise<ServeState>
  stopServer: () => Promise<ServeState>
  restartServer: (forceKillConflict?: boolean) => Promise<ServeState>
  getLogs: (limit?: number) => Promise<LogEntry[]>
  clearLogs: () => Promise<boolean>
  subscribeLogs: (cb: (entry: LogEntry) => void) => () => void
  subscribeDashboardRequests: (cb: () => void) => () => void
  detectOllamaBinary: () => Promise<string | null>
  listPresets: <K extends PresetKind>(kind: K) => Promise<Array<Preset<K>>>
  savePreset: <K extends PresetKind>(
    kind: K,
    name: string,
    data: PresetDataMap[K],
    id?: string
  ) => Promise<Preset<K>>
  deletePreset: (kind: PresetKind, id: string) => Promise<boolean>
  importPreset: <K extends PresetKind>(kind: K, json: string) => Promise<Preset<K>>
  getContinueStatus: () => Promise<ContinueConfigStatus>
  upsertContinueModel: (modelName: string) => Promise<ContinueModelEntry>
  removeContinueModel: (modelName: string) => Promise<boolean>
  getIntegrationsStatus: (modelNames: string[]) => Promise<IntegrationsStatus>
  upsertOpenCodeModel: (modelName: string) => Promise<OpenCodeModelEntry>
  removeOpenCodeModel: (modelName: string) => Promise<boolean>
  killOllamaProcess: (pid: number) => Promise<{ ok: boolean; error?: string }>
  getAppLanguage: () => Promise<AppLanguage>
  setAppLanguage: (language: AppLanguage) => Promise<AppLanguage>
}

declare global {
  interface Window {
    ollamaStudio: Api
  }
}

export function api(): Api {
  return window.ollamaStudio
}
