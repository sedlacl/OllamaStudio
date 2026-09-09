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

export type BackendLoadOptions = ModelLoadOptions | TabbyLoadOptions

/**
 * Jednotný kontrakt runtime backendu. Provider normalizuje vendor-specific API
 * do tvarů, které už používá IPC a renderer.
 */
export interface BackendProvider {
  readonly id: BackendId
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
  checkForUpdate(force?: boolean): Promise<OllamaUpdateInfo>
  deleteModel(modelId: string): Promise<void>
  cloneModel(source: string, destination: string): Promise<void>
  pullModel(
    modelId: string,
    onProgress: (progress: PullProgress) => void
  ): Promise<{ ok: boolean; error?: string }>
  killProcess(pid: number): Promise<KillProcessResult>
}
