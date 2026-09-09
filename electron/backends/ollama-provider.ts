import {
  ollamaClient,
  type ModelLoadOptions,
  type ModelSpeedTestResult,
  type ModelTag,
  type PullProgress,
  type RunningModel
} from '../ollama/client'
import type { AppConfig } from '../ollama/config'
import { getLoadOptions } from '../ollama/load-options-registry'
import { killOllamaRelatedProcess } from '../ollama/kill-process'
import { startModelLoad } from '../ollama/model-load-manager'
import { serveManager } from '../ollama/serve-manager'
import {
  OLLAMA_CAPABILITIES,
  type BackendServeState
} from './types'
import type { BackendLoadOptions, BackendProvider } from './provider'

function serveState(): BackendServeState {
  const state = serveManager.getState()
  return {
    backend: 'ollama',
    processStatus:
      state.status === 'error'
        ? 'failed'
        : (state.status as BackendServeState['processStatus']),
    endpointStatus:
      state.status === 'running'
        ? 'healthy'
        : state.status === 'starting'
          ? 'degraded'
          : 'unreachable',
    status: state.status,
    pid: state.pid,
    spawnTime: state.spawnTime,
    binaryPath: state.binaryPath,
    error: state.error,
    portConflict: state.portConflict,
    ownedByStudio: true,
    auth: { hasApiKey: true, hasAdminKey: true, disableAuth: true }
  }
}

export class OllamaProvider implements BackendProvider {
  readonly id = 'ollama' as const
  readonly displayName = 'Ollama'
  readonly capabilities = OLLAMA_CAPABILITIES
  readonly logVendor = 'ollama' as const

  getServeState(): BackendServeState {
    return serveState()
  }

  isRunning(): boolean {
    return serveManager.isRunning()
  }

  async start(forceKillConflict = false): Promise<BackendServeState> {
    await serveManager.start(forceKillConflict)
    return this.getServeState()
  }

  async stop(): Promise<BackendServeState> {
    await serveManager.stop()
    return this.getServeState()
  }

  async restart(forceKillConflict = false): Promise<BackendServeState> {
    await serveManager.restart(forceKillConflict)
    return this.getServeState()
  }

  async saveConfigAndRestart(config: AppConfig): Promise<BackendServeState> {
    await serveManager.saveConfigAndRestart(config)
    return this.getServeState()
  }

  async shutdown(): Promise<void> {
    await serveManager.shutdown()
  }

  subscribe(listener: () => void): () => void {
    return serveManager.subscribe(() => listener())
  }

  shouldAutoStart(config: AppConfig): boolean {
    return config.autoStartServe
  }

  async activate(_autoStart: boolean): Promise<BackendServeState> {
    // Přepnutí na Ollamu historicky pouze obnoví URL; server se spouští explicitně.
    this.refreshConnection()
    return this.getServeState()
  }

  detectBinary(): Promise<string | null> {
    return serveManager.detectBinary()
  }

  getBaseUrl(): string {
    return ollamaClient.getBaseUrl()
  }

  refreshConnection(): void {
    ollamaClient.refreshBaseUrl()
  }

  getPid(): number | null {
    return serveManager.getPid()
  }

  getSpawnTime(): number | null {
    return serveManager.getSpawnTime()
  }

  async getManagedPids(): Promise<number[]> {
    const pid = this.getPid()
    return pid == null ? [] : [pid]
  }

  metricsClient() {
    return ollamaClient
  }

  listModels(): Promise<ModelTag[]> {
    return ollamaClient.getTags()
  }

  listLoaded(): Promise<RunningModel[]> {
    return ollamaClient.getPs()
  }

  showModel(modelId: string) {
    return ollamaClient.show(modelId)
  }

  loadModel(
    modelId: string,
    options?: BackendLoadOptions,
    onLoaded?: (modelId: string) => void
  ): { ok: boolean; error?: string } {
    return startModelLoad(
      ollamaClient,
      modelId,
      options as ModelLoadOptions | undefined,
      onLoaded
    )
  }

  unloadModel(modelId: string): Promise<void> {
    return ollamaClient.unload(modelId)
  }

  testSpeed(modelId: string): Promise<ModelSpeedTestResult> {
    return ollamaClient.testSpeed(modelId, getLoadOptions(modelId)?.options ?? null)
  }

  checkForUpdate(force = false) {
    return ollamaClient.checkForUpdate({ force })
  }

  deleteModel(modelId: string): Promise<void> {
    return ollamaClient.delete(modelId)
  }

  cloneModel(source: string, destination: string): Promise<void> {
    return ollamaClient.copy(source, destination)
  }

  async pullModel(
    modelId: string,
    onProgress: (progress: PullProgress) => void
  ): Promise<{ ok: boolean; error?: string }> {
    for await (const progress of ollamaClient.pull(modelId)) {
      onProgress(progress)
    }
    return { ok: true }
  }

  killProcess(pid: number) {
    return killOllamaRelatedProcess(pid, {
      servePid: this.getPid(),
      stopServe: async () => {
        await this.stop()
      }
    })
  }
}

export const ollamaProvider = new OllamaProvider()
