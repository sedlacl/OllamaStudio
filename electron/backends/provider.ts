import type {
  ModelLoadOptions,
  ModelShow,
  ModelSpeedTestResult,
  ModelTag,
  OllamaUpdateInfo,
  PullProgress,
  RunningModel
} from '../ollama/client'
import type { AppConfig } from '../ollama/config'
import type { KillProcessResult } from '../ollama/kill-process'
import type { LogVendor } from '../ollama/log-buffer'
import type { MetricsClient } from '../ollama/metrics'
import type { TabbyLoadOptions } from '../tabby/client'
import type { BackendCapabilities, BackendId, BackendServeState } from './types'
import type {
  AcquisitionState,
  BackendDescriptor,
  CatalogModel,
  ModelAcquisitionRequest,
  ModelAcquisitionResult,
  ModelCompatibilityDecision,
  ModelProfile,
  ModelRef,
  ProviderActionName,
  ProviderActionPayload,
  ProviderActionResult
} from '../../shared/backend-contract'

export type BackendLoadOptions =
  | ModelLoadOptions
  | (Omit<TabbyLoadOptions, 'modelName'> & { modelName?: string })

/**
 * Jednotný kontrakt runtime backendu. Provider normalizuje vendor-specific API
 * do tvarů, které už používá IPC a renderer.
 */
export interface BackendProvider {
  readonly id: BackendId
  readonly descriptor: BackendDescriptor
  readonly displayName: string
  readonly capabilities: BackendCapabilities
  readonly logVendor: LogVendor

  getServeState(): BackendServeState
  isRunning(): boolean
  start(forceKillConflict?: boolean): Promise<BackendServeState>
  stop(): Promise<BackendServeState>
  restart(forceKillConflict?: boolean): Promise<BackendServeState>
  saveConfigAndRestart(config: AppConfig): Promise<BackendServeState>
  shutdown(): Promise<void>
  subscribe(listener: () => void): () => void
  shouldAutoStart(config: AppConfig): boolean
  /**
   * Aktivuje připojení po přepnutí/startu aplikace. Backend smí převzít nebo
   * detekovat již běžící instanci, aniž by ji při autoStart=false spouštěl.
   */
  activate(autoStart: boolean): Promise<BackendServeState>

  detectBinary(): Promise<string | null>
  getBaseUrl(): string
  refreshConnection(): void
  getPid(): number | null
  getSpawnTime(): number | null
  getManagedPids(): Promise<number[]>
  metricsClient(): MetricsClient

  /** Discovery nesmí startovat ani měnit managed inference runtime. */
  discoverModels(): Promise<CatalogModel[]>
  getModelMetadata(ref: ModelRef): Promise<CatalogModel | null>
  decideModelCompatibility(
    ref: ModelRef,
    profile: ModelProfile
  ): Promise<ModelCompatibilityDecision>
  startForModel(profile: ModelProfile): Promise<BackendServeState>
  restartForModel(profile: ModelProfile): Promise<BackendServeState>
  clearRuntimeModelState(): void

  initializeAcquisition(
    persistenceDir: string,
    onChanged: (state: AcquisitionState) => void
  ): Promise<AcquisitionState[]>
  resolveAcquisitionModelId(request: ModelAcquisitionRequest): string
  acquireModel(
    request: ModelAcquisitionRequest,
    operationId: string,
    onProgress: (state: Partial<AcquisitionState>) => void
  ): Promise<ModelAcquisitionResult>
  dismissAcquisition(operationId: string): Promise<void>
  invokeAction<A extends ProviderActionName<this['id']>>(
    action: A,
    payload: ProviderActionPayload<this['id'], A>
  ): Promise<ProviderActionResult<this['id'], A>>

  listModels(): Promise<ModelTag[]>
  listLoaded(): Promise<RunningModel[]>
  showModel(modelId: string): Promise<ModelShow>
  loadModel(
    modelId: string,
    options?: BackendLoadOptions,
    onLoaded?: (modelId: string) => void
  ): { ok: boolean; error?: string }
  unloadModel(modelId: string): Promise<void>
  testSpeed(modelId: string): Promise<ModelSpeedTestResult>
  runTestQuery(
    modelId: string,
    params: {
      prompt: string
      maxTokens: number
      timeoutMs: number
    }
  ): Promise<{
    text: string
    thinking: string
    ttftMs: number
    totalMs: number
    generatedTokens: number | null
    tokensPerSecond: number | null
    promptTokens: number | null
  }>
  checkForUpdate(force?: boolean): Promise<OllamaUpdateInfo>
  deleteModel(modelId: string): Promise<void>
  cloneModel(
    source: string,
    destination: string,
    options?: { stripVision?: boolean; onProgress?: (status: string) => void }
  ): Promise<void>
  pullModel(
    modelId: string,
    onProgress: (progress: PullProgress) => void
  ): Promise<{ ok: boolean; error?: string }>
  killProcess(pid: number): Promise<KillProcessResult>
}
