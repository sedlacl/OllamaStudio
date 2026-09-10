export type AppLanguage = 'cs' | 'en'

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
  OLLAMA_MODELS: string
}

export interface TabbyConfig {
  installDir: string
  pythonPath: string
  configPath: string
  host: string
  port: number
  modelDir: string
  autoStartServe: boolean
}

export interface OllamaProviderConfig {
  autoStartServe: boolean
  env: OllamaEnvConfig
  profileDefaults: {
    keepAlive: string
    numCtx: number
  }
}

export interface BackendConfigMap {
  ollama: OllamaProviderConfig
  tabby: TabbyConfig
}

export type BackendId = keyof BackendConfigMap

export interface McpConfig {
  enabled: boolean
  port: number
  token: string
}

export type McpRuntimeStatus = 'stopped' | 'starting' | 'listening' | 'error'

export interface McpRuntimeState {
  status: McpRuntimeStatus
  port: number | null
  url: string | null
  error: string | null
  startedAt: number | null
}

export interface McpSettingsSnapshot {
  settings: McpConfig
  runtime: McpRuntimeState
}

export interface AppConfig {
  configVersion?: number
  activeBackend?: BackendId
  language?: AppLanguage
  mcp?: McpConfig
  providers: BackendConfigMap
  /** @deprecated Přechodový read/write alias pro starší renderer a moduly. */
  ollamaEnv: OllamaEnvConfig
  /** @deprecated Přechodový read/write alias pro providers.ollama.autoStartServe. */
  autoStartServe: boolean
  /** @deprecated Přechodový read/write alias pro providers.tabby. */
  tabby: TabbyConfig
}

export interface ModelRef {
  providerId: BackendId
  modelId: string
}

export interface CatalogModel extends ModelRef {
  displayName: string
  sizeBytes: number | null
  loaded?: boolean
  metadata?: Record<string, unknown>
}

export interface BackendError {
  code: string
  vars?: Record<string, string | number | boolean | null>
}

export interface CatalogProviderState {
  providerId: BackendId
  status: 'ok' | 'error'
  modelCount: number
  error?: BackendError
}

export interface AggregatedModelCatalog {
  models: CatalogModel[]
  providers: CatalogProviderState[]
  refreshedAt: number
}

export type ModelCompatibilityAction = 'reuse' | 'reload-model' | 'restart-provider'

export interface ModelCompatibilityDecision {
  action: ModelCompatibilityAction
  fingerprint: string
  reason:
    | 'provider-stopped'
    | 'runtime-unverified'
    | 'context-changed'
    | 'model-changed'
    | 'profile-changed'
    | 'compatible'
}

export interface ModelOperationRequest<I extends BackendId = BackendId> {
  ref: ModelRef & { providerId: I }
  profile?: ModelProfile<I>
}

export interface ModelLoadResult {
  ok: boolean
  error?: string
  action?: ModelCompatibilityAction
}

export interface BackendCapabilities {
  pullLibraryTag: boolean
  cloneModel: boolean
  deleteModel: boolean
  keepAlive: boolean
  multiLoaded: boolean
  hfDownload: boolean
  mtp: boolean
  speedTestAutoAfterLoad: boolean
  continueIntegration: boolean
  opencodeIntegration: boolean
}

export type SettingsFieldType = 'string' | 'number' | 'boolean' | 'select' | 'path'

export interface SettingsFieldDescriptor {
  id: string
  type: SettingsFieldType
  labelKey: string
  helpKey?: string
  restartRequired: boolean
  min?: number
  max?: number
  options?: ReadonlyArray<{ value: string; labelKey: string }>
}

export interface SettingsDescriptor {
  fields: ReadonlyArray<SettingsFieldDescriptor>
}

export interface BackendDescriptor {
  id: BackendId
  displayNameKey: string
  capabilities: BackendCapabilities
  acquisition: 'ollama-library' | 'hugging-face' | null
  settings: SettingsDescriptor
}

export type AcquisitionStatus =
  | 'running'
  | 'success'
  | 'error'
  | 'interrupted'
  | 'conflict'

export interface AcquisitionState extends ModelRef {
  operationId: string
  status: AcquisitionStatus
  bytesDownloaded?: number
  bytesTotal?: number | null
  percent?: number | null
  bytesPerSec?: number | null
  etaSeconds?: number | null
  error?: string
  details?: unknown
  startedAt: number
  updatedAt: number
}

export interface OllamaAcquisitionRequest {
  providerId: 'ollama'
  modelId: string
  source: 'library'
}

export interface TabbyAcquisitionRequest {
  providerId: 'tabby'
  /** Cílový lokální název. Pokud chybí, provider ho odvodí z repo/revision. */
  modelId?: string
  source: 'hugging-face'
  repoId: string
  revision?: string
  folderName?: string
  /** Jednorázový secret; nesmí se objevit ve stavu, logu ani persistence. */
  token?: string
}

export type ModelAcquisitionRequest =
  | OllamaAcquisitionRequest
  | TabbyAcquisitionRequest

export interface ModelAcquisitionResult {
  ok: boolean
  operationId: string
  error?: string
  alreadyRunning?: boolean
  details?: unknown
}

export interface TabbyDownloadForm {
  repoId: string
  revision: string
  folderName: string
}

export interface HfRevision {
  name: string
  type: 'branch' | 'tag'
}

export interface TabbyPreflightResult {
  ok: boolean
  installDir: string
  pythonPath: string
  configPath: string
  mainPy: string
  errors: string[]
  warnings: string[]
}

export interface LogScrubFileResult {
  ok: boolean
  path: string
  linesRead: number
  linesChanged: number
  error?: string
}

export interface TabbyRuntimeLogScrubResult {
  scrubbed: LogScrubFileResult[]
  zipFiles: string[]
  skippedZip: boolean
}

export type OllamaUpdateInstallerReason =
  | 'available'
  | 'unsupported-platform'
  | 'manager-not-found'
  | 'package-not-found'
  | 'terminal-not-found'
  | 'launch-failed'

interface OllamaUpdateInstallerStatusBase {
  platform: 'win32' | 'linux' | 'unsupported'
  manager: 'winget' | 'apt' | null
  command: string | null
}

export type OllamaUpdateInstallerStatus =
  | (OllamaUpdateInstallerStatusBase & {
      available: true
      reason: 'available'
    })
  | (OllamaUpdateInstallerStatusBase & {
      available: false
      reason: Exclude<OllamaUpdateInstallerReason, 'available' | 'launch-failed'>
    })

export interface OllamaUpdateLaunchResult {
  ok: boolean
  reason?: Exclude<OllamaUpdateInstallerReason, 'available'>
}

export interface ProviderActionMap {
  ollama: {
    'runtime.detect-binary': {
      payload: Record<string, never>
      result: string | null
    }
    'runtime.update-installer-status': {
      payload: Record<string, never>
      result: OllamaUpdateInstallerStatus
    }
    'runtime.open-update-terminal': {
      payload: Record<string, never>
      result: OllamaUpdateLaunchResult
    }
  }
  tabby: {
    'runtime.preflight': {
      payload: Record<string, never>
      result: TabbyPreflightResult
    }
    'hf.refs': {
      payload: { repoId: string; token?: string }
      result: { ok: boolean; revisions?: HfRevision[]; error?: string }
    }
    'download.remember-form': {
      payload: TabbyDownloadForm
      result: TabbyDownloadForm
    }
    'download.delete-folder': {
      payload: { folderName: string }
      result: { ok: boolean; error?: string }
    }
    'runtime.scrub-logs': {
      payload: Record<string, never>
      result: TabbyRuntimeLogScrubResult
    }
    'runtime.delete-zip-logs': {
      payload: { zipPaths: string[] }
      result: { deleted: string[]; errors: string[] }
    }
  }
}

export type ProviderActionName<I extends BackendId> =
  keyof ProviderActionMap[I] & string

export type ProviderActionPayload<
  I extends BackendId,
  A extends ProviderActionName<I>
> = ProviderActionMap[I][A] extends { payload: infer P } ? P : never

export type ProviderActionResult<
  I extends BackendId,
  A extends ProviderActionName<I>
> = ProviderActionMap[I][A] extends { result: infer R } ? R : never

export type ProviderActionRequest<
  I extends BackendId,
  A extends ProviderActionName<I>
> = {
  providerId: I
  action: A
  payload: ProviderActionPayload<I, A>
}

export type AnyProviderActionRequest = {
  [I in BackendId]: {
    [A in ProviderActionName<I>]: ProviderActionRequest<I, A>
  }[ProviderActionName<I>]
}[BackendId]

export interface OllamaModelProfile {
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

export interface TabbyModelProfile {
  maxSeqLen?: number
  cacheSize?: number
  cacheMode?: string
  tensorParallel?: boolean
  gpuSplitAuto?: boolean
  gpuSplit?: number[]
  autosplitReserve?: number[]
  ropeScale?: number
  ropeAlpha?: number | 'auto'
  chunkSize?: number
  outputChunking?: boolean
  vision?: boolean
  promptTemplate?: string
  mtp?: {
    enabled: boolean
    draftNumTokens?: number
    dynamicDraft?: boolean
  }
  draftModel?: {
    draftModelName?: string
    draftRopeScale?: number
    draftRopeAlpha?: number | 'auto'
    draftGpuSplit?: number[]
  }
}

export interface ProviderModelProfileMap {
  ollama: OllamaModelProfile
  tabby: TabbyModelProfile
}

export type ModelProfile<I extends BackendId = BackendId> = ProviderModelProfileMap[I]
export type PresetScope = 'model-profile' | 'settings'

export interface ProviderPreset<I extends BackendId = BackendId> {
  id: string
  name: string
  providerId: I
  scope: PresetScope
  schemaVersion: number
  updatedAt: number
  data: unknown
}

export function canonicalizeModelRef(ref: ModelRef): ModelRef {
  return {
    providerId: ref.providerId,
    modelId: ref.modelId.trim().toLocaleLowerCase('en-US')
  }
}

export function modelRefKey(ref: ModelRef): string {
  const canonical = canonicalizeModelRef(ref)
  return JSON.stringify([canonical.providerId, canonical.modelId])
}

export function isBackendId(value: unknown): value is BackendId {
  return value === 'ollama' || value === 'tabby'
}
