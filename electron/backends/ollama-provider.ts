import {
  ollamaClient,
  type ModelLoadOptions,
  type ModelSpeedTestResult,
  type ModelTag,
  type PullProgress,
  type RunningModel
} from '../ollama/client'
import {
  detectWslWindowsOllamaModelsDir,
  loadConfig,
  type AppConfig
} from '../ollama/config'
import { getLoadOptions } from '../ollama/load-options-registry'
import { killOllamaRelatedProcess } from '../ollama/kill-process'
import { startModelLoad } from '../ollama/model-load-manager'
import { serveManager } from '../ollama/serve-manager'
import {
  OLLAMA_CAPABILITIES,
  type BackendServeState
} from './types'
import type { BackendLoadOptions, BackendProvider } from './provider'
import { modelProfileStore } from './model-profile-store'
import { BACKEND_DESCRIPTORS, profileFingerprint } from './definitions'
import { ollamaPullProgressToAcquisition } from './acquisition-progress'
import {
  discoverOllamaModels,
  resolveOllamaModelsRoot
} from './ollama-offline-catalog'
import {
  detectOllamaUpdateInstaller,
  openOllamaUpdateTerminal
} from '../ollama/update-installer'
import {
  modelRefKey,
  type AcquisitionState,
  type CatalogModel,
  type ModelAcquisitionRequest,
  type ModelAcquisitionResult,
  type ModelCompatibilityDecision,
  type ModelProfile,
  type ModelRef,
  type OllamaModelProfile,
  type ProviderActionName,
  type ProviderActionPayload,
  type ProviderActionResult
} from '../../shared/backend-contract'

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
  readonly descriptor = BACKEND_DESCRIPTORS.ollama
  readonly displayName = 'Ollama'
  readonly capabilities = OLLAMA_CAPABILITIES
  readonly logVendor = 'ollama' as const
  private runtimeContext: number | null = null
  private readonly loadedFingerprints = new Map<string, string>()

  getServeState(): BackendServeState {
    return serveState()
  }

  isRunning(): boolean {
    return serveManager.isRunning()
  }

  async start(forceKillConflict = false): Promise<BackendServeState> {
    this.clearRuntimeModelState()
    await serveManager.start(forceKillConflict)
    return this.getServeState()
  }

  async stop(): Promise<BackendServeState> {
    await serveManager.stop()
    this.clearRuntimeModelState()
    return this.getServeState()
  }

  async restart(forceKillConflict = false): Promise<BackendServeState> {
    this.clearRuntimeModelState()
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

  discoverModels(): Promise<CatalogModel[]> {
    const configured = loadConfig().providers.ollama.env.OLLAMA_MODELS
    const root = resolveOllamaModelsRoot(
      configured.trim() ? configured : detectWslWindowsOllamaModelsDir() ?? ''
    )
    return discoverOllamaModels(root)
  }

  async getModelMetadata(ref: ModelRef): Promise<CatalogModel | null> {
    if (ref.providerId !== this.id) return null
    const models = await this.discoverModels()
    return models.find((model) => modelRefKey(model) === modelRefKey(ref)) ?? null
  }

  async decideModelCompatibility(
    ref: ModelRef,
    profile: ModelProfile
  ): Promise<ModelCompatibilityDecision> {
    const fingerprint = profileFingerprint(this.id, profile)
    if (!this.isRunning()) {
      return { action: 'restart-provider', fingerprint, reason: 'provider-stopped' }
    }
    const context = (profile as OllamaModelProfile).numCtx
      ?? loadConfig().providers.ollama.profileDefaults.numCtx
    if (this.runtimeContext == null) {
      return { action: 'restart-provider', fingerprint, reason: 'runtime-unverified' }
    }
    if (this.runtimeContext !== context) {
      return { action: 'restart-provider', fingerprint, reason: 'context-changed' }
    }
    let loaded = false
    try {
      loaded = (await this.listLoaded()).some(
        (model) => modelRefKey({ providerId: this.id, modelId: model.model || model.name })
          === modelRefKey(ref)
      )
    } catch {
      return { action: 'reload-model', fingerprint, reason: 'runtime-unverified' }
    }
    if (!loaded) return { action: 'reload-model', fingerprint, reason: 'model-changed' }
    const knownFingerprint = this.loadedFingerprints.get(modelRefKey(ref))
    if (!knownFingerprint) {
      return { action: 'reload-model', fingerprint, reason: 'runtime-unverified' }
    }
    return knownFingerprint === fingerprint
      ? { action: 'reuse', fingerprint, reason: 'compatible' }
      : { action: 'reload-model', fingerprint, reason: 'profile-changed' }
  }

  async startForModel(profile: ModelProfile): Promise<BackendServeState> {
    const context = (profile as OllamaModelProfile).numCtx
      ?? loadConfig().providers.ollama.profileDefaults.numCtx
    this.clearRuntimeModelState()
    await serveManager.start(false, { OLLAMA_CONTEXT_LENGTH: String(context) })
    const state = this.getServeState()
    if (state.status === 'running') this.runtimeContext = context
    return state
  }

  async restartForModel(profile: ModelProfile): Promise<BackendServeState> {
    const state = this.getServeState()
    if (!state.ownedByStudio) {
      throw new Error('EXTERNAL_RUNTIME_RESTART_FORBIDDEN')
    }
    const context = (profile as OllamaModelProfile).numCtx
      ?? loadConfig().providers.ollama.profileDefaults.numCtx
    this.clearRuntimeModelState()
    await serveManager.restart(false, { OLLAMA_CONTEXT_LENGTH: String(context) })
    const next = this.getServeState()
    if (next.status === 'running') this.runtimeContext = context
    return next
  }

  clearRuntimeModelState(): void {
    this.runtimeContext = null
    this.loadedFingerprints.clear()
  }

  async initializeAcquisition(
    _persistenceDir: string,
    _onChanged: (state: AcquisitionState) => void
  ): Promise<AcquisitionState[]> {
    return []
  }

  resolveAcquisitionModelId(request: ModelAcquisitionRequest): string {
    return request.providerId === this.id ? request.modelId.trim() : ''
  }

  async acquireModel(
    request: ModelAcquisitionRequest,
    operationId: string,
    onProgress: (state: Partial<AcquisitionState>) => void
  ): Promise<ModelAcquisitionResult> {
    if (
      request.providerId !== this.id ||
      request.source !== 'library' ||
      !request.modelId.trim()
    ) {
      return { ok: false, operationId, error: 'INVALID_OLLAMA_ACQUISITION' }
    }
    const modelId = request.modelId.trim()
    return this.pullModel(modelId, (progress) => {
      onProgress(ollamaPullProgressToAcquisition(progress))
    }).then((result) => ({ ...result, operationId }))
  }

  async dismissAcquisition(_operationId: string): Promise<void> {}

  async invokeAction<A extends ProviderActionName<this['id']>>(
    action: A,
    _payload: ProviderActionPayload<this['id'], A>
  ): Promise<ProviderActionResult<this['id'], A>> {
    switch (action) {
      case 'runtime.detect-binary':
        return (await this.detectBinary()) as ProviderActionResult<this['id'], A>
      case 'runtime.update-installer-status':
        return (await detectOllamaUpdateInstaller()) as ProviderActionResult<this['id'], A>
      case 'runtime.open-update-terminal':
        return (await openOllamaUpdateTerminal()) as ProviderActionResult<this['id'], A>
      default:
        throw new Error('UNKNOWN_PROVIDER_ACTION')
    }
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
    const ref = { providerId: this.id, modelId }
    const profile = modelProfileStore.save(ref, options ?? modelProfileStore.get(ref))
    const fingerprint = profileFingerprint(this.id, profile)
    return startModelLoad(
      ollamaClient,
      ref,
      profile as ModelLoadOptions,
      (loaded) => {
        this.loadedFingerprints.set(modelRefKey(ref), fingerprint)
        onLoaded?.(loaded)
      }
    )
  }

  unloadModel(modelId: string): Promise<void> {
    this.loadedFingerprints.delete(modelRefKey({ providerId: this.id, modelId }))
    return ollamaClient.unload(modelId)
  }

  testSpeed(modelId: string): Promise<ModelSpeedTestResult> {
    return ollamaClient.testSpeed(
      modelId,
      getLoadOptions({ providerId: this.id, modelId })?.options ??
        modelProfileStore.get({ providerId: this.id, modelId })
    )
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
