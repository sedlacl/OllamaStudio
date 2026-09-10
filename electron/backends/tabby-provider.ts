import type {
  ModelShow,
  ModelSpeedTestResult,
  ModelTag,
  OllamaUpdateInfo,
  PullProgress,
  RunningModel
} from '../ollama/client'
import { readdirSync } from 'fs'
import { join } from 'path'
import {
  DEFAULT_TABBY_CONFIG,
  loadConfig,
  resolveTabbyModelDir,
  type AppConfig
} from '../ollama/config'
import { recordLoadOptions } from '../ollama/load-options-registry'
import { killOllamaRelatedProcess } from '../ollama/kill-process'
import { logBuffer } from '../ollama/log-buffer'
import { startBackgroundModelLoad } from '../ollama/model-load-manager'
import { tMain } from '../i18n'
import { tabbyClient, type TabbyLoadOptions } from '../tabby/client'
import { getDownloadStatusSnapshot } from '../tabby/download-session'
import {
  configureDownloadSession,
  dismissDownloadSession,
  recoverPersistedDownload,
  rememberDownloadForm,
  type TabbyDownloadStatusSnapshot
} from '../tabby/download-session'
import {
  deleteTabbyDownloadFolder,
  hfErrorToMessage,
  runTabbyHfDownload
} from '../tabby/hf-download'
import { resolveDownloadFolderName } from '../tabby/hf-download-helpers'
import { directoryByteSize, fetchHfRevisions } from '../tabby/hf-hub'
import { tabbyProcessSize } from '../tabby/loaded-memory-live'
import {
  enrichTabbyModelSummaries,
  invalidateLocalModelCache
} from '../tabby/local-model-info'
import { writeModelMtpConfig } from '../tabby/model-config'
import { preflightTabby, tabbyServeManager } from '../tabby/serve-manager'
import { TABBY_DEFAULT_CONTEXT_LENGTH } from '../ollama/opencode-config'
import {
  deleteTabbyRuntimeZipLogs,
  scrubTabbyRuntimeTextLogs
} from '../security/log-scrub'
import { registerSecret } from '../security/secret-redactor'
import { withBackendLogMutex } from '../security/studio-log-persistence'
import { TABBY_CAPABILITIES, type BackendServeState } from './types'
import type { BackendLoadOptions, BackendProvider } from './provider'
import { modelProfileStore } from './model-profile-store'
import { BACKEND_DESCRIPTORS, profileFingerprint } from './definitions'
import { tabbyDownloadProgressToAcquisition } from './acquisition-progress'
import { discoverTabbyModels } from './tabby-offline-catalog'
import {
  modelRefKey,
  type AcquisitionState,
  type CatalogModel,
  type ModelAcquisitionRequest,
  type ModelAcquisitionResult,
  type ModelCompatibilityDecision,
  type ModelProfile,
  type ModelRef,
  type ProviderActionName,
  type ProviderActionPayload,
  type ProviderActionResult
} from '../../shared/backend-contract'

function acquisitionFromSnapshot(
  snapshot: TabbyDownloadStatusSnapshot
): AcquisitionState | null {
  const session = snapshot.session
  if (!session) return null
  return {
    providerId: 'tabby',
    modelId: session.folderName,
    operationId: session.operationId,
    status: session.status,
    bytesDownloaded: session.downloadedBytes,
    bytesTotal: session.totalBytes,
    percent: session.percent,
    bytesPerSec: session.bytesPerSec,
    etaSeconds: session.etaSeconds,
    error: session.error,
    details: {
      repoId: session.repoId,
      revision: session.revision,
      folderName: session.folderName,
      folderConflict: session.folderConflict
    },
    startedAt: session.startedAt,
    updatedAt: session.updatedAt
  }
}

type TabbyStudioLoadOptions = TabbyLoadOptions & {
  mtp?: {
    enabled: boolean
    draftNumTokens?: number
    dynamicDraft?: boolean
  }
}

function tagsFromTabby(
  models: Awaited<ReturnType<typeof tabbyClient.listModels>>
): ModelTag[] {
  return models.map((model) => ({
    name: model.modelId,
    model: model.modelId,
    modified_at: model.modifiedAt ?? new Date().toISOString(),
    size: model.sizeBytes ?? null,
    digest: model.digest ?? '',
    local_status: model.localCompleteness,
    details: {
      format: model.format ?? 'exl3',
      family: model.family ?? '',
      parameter_size: model.parameterSize ?? '',
      quantization_level: model.quantization ?? ''
    }
  }))
}

export class TabbyProvider implements BackendProvider {
  readonly id = 'tabby' as const
  readonly descriptor = BACKEND_DESCRIPTORS.tabby
  readonly displayName = 'TabbyAPI'
  readonly capabilities = TABBY_CAPABILITIES
  readonly logVendor = 'tabby' as const
  private readonly loadedFingerprints = new Map<string, string>()

  getServeState(): BackendServeState {
    return tabbyServeManager.getState()
  }

  isRunning(): boolean {
    return tabbyServeManager.isRunning()
  }

  async start(forceKillConflict = false): Promise<BackendServeState> {
    this.clearRuntimeModelState()
    await tabbyServeManager.start(forceKillConflict)
    return this.getServeState()
  }

  async stop(): Promise<BackendServeState> {
    await tabbyServeManager.stop()
    this.clearRuntimeModelState()
    return this.getServeState()
  }

  async restart(forceKillConflict = false): Promise<BackendServeState> {
    this.clearRuntimeModelState()
    await tabbyServeManager.restart(forceKillConflict)
    return this.getServeState()
  }

  async saveConfigAndRestart(config: AppConfig): Promise<BackendServeState> {
    await tabbyServeManager.saveConfigAndRestart(config)
    return this.getServeState()
  }

  async shutdown(): Promise<void> {
    await tabbyServeManager.shutdown()
  }

  subscribe(listener: () => void): () => void {
    return tabbyServeManager.subscribe(() => listener())
  }

  shouldAutoStart(config: AppConfig): boolean {
    return Boolean(config.tabby?.autoStartServe)
  }

  async activate(autoStart: boolean): Promise<BackendServeState> {
    this.refreshConnection()
    if (autoStart) await tabbyServeManager.start()
    else await tabbyServeManager.adoptOrDetect()
    return this.getServeState()
  }

  async detectBinary(): Promise<string | null> {
    return preflightTabby().pythonPath
  }

  getBaseUrl(): string {
    return tabbyClient.getBaseUrl()
  }

  refreshConnection(): void {
    tabbyClient.refresh()
  }

  getPid(): number | null {
    return tabbyServeManager.getPid()
  }

  getSpawnTime(): number | null {
    return tabbyServeManager.getSpawnTime()
  }

  getManagedPids(): Promise<number[]> {
    return tabbyServeManager.getManagedPids()
  }

  metricsClient() {
    return {
      getPs: () => this.listLoaded(),
      getVersion: async () => {
        await tabbyClient.getHealth()
        return 'TabbyAPI'
      }
    }
  }

  discoverModels(): Promise<CatalogModel[]> {
    const config = loadConfig()
    const modelDir = resolveTabbyModelDir(config.providers.tabby)
    return discoverTabbyModels(modelDir)
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
    let current
    try {
      current = await tabbyClient.getCurrentModel()
    } catch {
      return { action: 'reload-model', fingerprint, reason: 'runtime-unverified' }
    }
    if (!current || modelRefKey({ providerId: this.id, modelId: current.modelId }) !== modelRefKey(ref)) {
      return { action: 'reload-model', fingerprint, reason: 'model-changed' }
    }
    const knownFingerprint = this.loadedFingerprints.get(modelRefKey(ref))
    if (!knownFingerprint) {
      return { action: 'reload-model', fingerprint, reason: 'runtime-unverified' }
    }
    return knownFingerprint === fingerprint
      ? { action: 'reuse', fingerprint, reason: 'compatible' }
      : { action: 'reload-model', fingerprint, reason: 'profile-changed' }
  }

  async startForModel(_profile: ModelProfile): Promise<BackendServeState> {
    this.clearRuntimeModelState()
    await tabbyServeManager.start(false)
    return this.getServeState()
  }

  async restartForModel(_profile: ModelProfile): Promise<BackendServeState> {
    const state = this.getServeState()
    if (!state.ownedByStudio) {
      throw new Error('EXTERNAL_RUNTIME_RESTART_FORBIDDEN')
    }
    this.clearRuntimeModelState()
    await tabbyServeManager.restart(false)
    return this.getServeState()
  }

  clearRuntimeModelState(): void {
    this.loadedFingerprints.clear()
  }

  async initializeAcquisition(
    persistenceDir: string,
    onChanged: (state: AcquisitionState) => void
  ): Promise<AcquisitionState[]> {
    configureDownloadSession({
      persistFile: join(persistenceDir, 'tabby-download.json'),
      log: (level, text) => logBuffer.appendApp(level, text),
      emit: (snapshot) => {
        const state = acquisitionFromSnapshot(snapshot)
        if (state) onChanged(state)
      }
    })
    const config = loadConfig()
    const modelDir = resolveTabbyModelDir(config.providers.tabby)
    const snapshot = await recoverPersistedDownload({
      modelDir,
      measureBytes: directoryByteSize,
      listSiblingNames: async (dir) => {
        try {
          return readdirSync(dir)
        } catch {
          return []
        }
      }
    })
    const restored = acquisitionFromSnapshot(snapshot)
    return restored ? [restored] : []
  }

  resolveAcquisitionModelId(request: ModelAcquisitionRequest): string {
    if (request.providerId !== this.id) return ''
    return resolveDownloadFolderName(
      request.repoId,
      request.revision,
      request.folderName ?? request.modelId
    )
  }

  async acquireModel(
    request: ModelAcquisitionRequest,
    operationId: string,
    onProgress: (state: Partial<AcquisitionState>) => void
  ): Promise<ModelAcquisitionResult> {
    if (
      request.providerId !== this.id ||
      request.source !== 'hugging-face' ||
      !request.repoId.trim()
    ) {
      return { ok: false, operationId, error: 'INVALID_TABBY_ACQUISITION' }
    }
    const modelDir = resolveTabbyModelDir(loadConfig().providers.tabby)
    const result = await runTabbyHfDownload({
      req: {
        repoId: request.repoId,
        revision: request.revision,
        folderName: request.folderName ?? request.modelId,
        token: request.token
      },
      operationId,
      modelDir,
      emit: (progress) =>
        onProgress(tabbyDownloadProgressToAcquisition(progress)),
      download: (downloadRequest) => tabbyClient.downloadModel(downloadRequest)
    })
    const session = getDownloadStatusSnapshot().session
    return {
      ok: result.ok,
      operationId,
      error: result.error,
      alreadyRunning: result.alreadyRunning,
      details: {
        status: session?.status ?? (result.ok ? 'success' : 'error'),
        downloadPath: result.downloadPath,
        folderConflict: result.folderConflict
      }
    }
  }

  async dismissAcquisition(operationId: string): Promise<void> {
    const session = getDownloadStatusSnapshot().session
    if (session?.operationId === operationId) dismissDownloadSession()
  }

  async invokeAction<A extends ProviderActionName<this['id']>>(
    action: A,
    payload: ProviderActionPayload<this['id'], A>
  ): Promise<ProviderActionResult<this['id'], A>> {
    const input = payload as Record<string, unknown>
    switch (action) {
      case 'runtime.preflight':
        return preflightTabby() as ProviderActionResult<this['id'], A>
      case 'hf.refs': {
        const repoId = typeof input.repoId === 'string' ? input.repoId.trim() : ''
        const token =
          typeof input.token === 'string' && input.token.trim()
            ? input.token.trim()
            : undefined
        if (!repoId) {
          return {
            ok: false,
            error: tMain('errors.hfRepoIdEmpty')
          } as ProviderActionResult<this['id'], A>
        }
        const releaseToken = token ? registerSecret(token) : () => {}
        try {
          return {
            ok: true,
            revisions: await fetchHfRevisions(repoId, token)
          } as ProviderActionResult<this['id'], A>
        } catch (error) {
          return {
            ok: false,
            error: hfErrorToMessage(error)
          } as ProviderActionResult<this['id'], A>
        } finally {
          releaseToken()
        }
      }
      case 'download.remember-form':
        return rememberDownloadForm({
          repoId: typeof input.repoId === 'string' ? input.repoId : '',
          revision: typeof input.revision === 'string' ? input.revision : '',
          folderName: typeof input.folderName === 'string' ? input.folderName : ''
        }).form as ProviderActionResult<this['id'], A>
      case 'download.delete-folder': {
        const folderName =
          typeof input.folderName === 'string' ? input.folderName : ''
        const modelDir = resolveTabbyModelDir(loadConfig().providers.tabby)
        const result = await deleteTabbyDownloadFolder(modelDir, folderName)
        if (result.ok) invalidateLocalModelCache(folderName)
        return result as ProviderActionResult<this['id'], A>
      }
      case 'runtime.scrub-logs':
        return withBackendLogMutex(async () => {
          this.assertStoppedForRuntimeLogOps()
          return scrubTabbyRuntimeTextLogs(loadConfig().providers.tabby.installDir)
        }) as Promise<ProviderActionResult<this['id'], A>>
      case 'runtime.delete-zip-logs':
        return withBackendLogMutex(async () => {
          this.assertStoppedForRuntimeLogOps()
          const zipPaths = Array.isArray(input.zipPaths)
            ? input.zipPaths.filter((item): item is string => typeof item === 'string')
            : []
          if (zipPaths.length === 0) return { deleted: [], errors: [] }
          return deleteTabbyRuntimeZipLogs(
            loadConfig().providers.tabby.installDir,
            zipPaths
          )
        }) as Promise<ProviderActionResult<this['id'], A>>
      default:
        throw new Error('UNKNOWN_PROVIDER_ACTION')
    }
  }

  async listModels(): Promise<ModelTag[]> {
    this.refreshConnection()
    const config = loadConfig()
    const modelDir = resolveTabbyModelDir(config.tabby ?? DEFAULT_TABBY_CONFIG)
    const listed = await tabbyClient.listModels()
    const enriched = await enrichTabbyModelSummaries(
      listed,
      modelDir,
      getDownloadStatusSnapshot()
    )
    return tagsFromTabby(enriched)
  }

  async listLoaded(): Promise<RunningModel[]> {
    const current = await tabbyClient.getCurrentModel()
    if (!current) return []
    const memory = await this.loadedSizes()
    return [
      {
        name: current.modelId,
        model: current.modelId,
        size: memory.size,
        size_vram: memory.sizeVram,
        digest: '',
        expires_at: '',
        context_length: current.contextLength,
        details: {
          format: 'exl3',
          family: current.cacheMode ?? '',
          parameter_size: current.draftMode ?? '',
          quantization_level: current.draftModelId ?? ''
        }
      }
    ]
  }

  async showModel(_modelId: string): Promise<ModelShow> {
    return {
      details: { format: 'exl3' },
      model_info: { 'general.architecture': 'exl3' },
      capabilities: ['completion']
    }
  }

  loadModel(
    modelId: string,
    options?: BackendLoadOptions,
    onLoaded?: (modelId: string) => void
  ): { ok: boolean; error?: string } {
    const requested =
      options && 'modelName' in options
        ? (options as TabbyStudioLoadOptions)
        : ({ modelName: modelId, ...(options as object | undefined) } as TabbyStudioLoadOptions)
    if (!requested.modelName) requested.modelName = modelId
    const ref = { providerId: this.id, modelId: requested.modelName }
    const profile = modelProfileStore.save(ref, requested)
    const fingerprint = profileFingerprint(this.id, profile)
    const tabbyOptions: TabbyStudioLoadOptions = { modelName: requested.modelName, ...profile }

    recordLoadOptions(ref, {
      keepAlive: '-1',
      numCtx: tabbyOptions.maxSeqLen ?? TABBY_DEFAULT_CONTEXT_LENGTH
    })

    return startBackgroundModelLoad(
      ref,
      async () => {
        logBuffer.appendApp('info', `[studio] tabby-load start ${tabbyOptions.modelName}`)
        if (tabbyOptions.mtp?.enabled) {
          writeModelMtpConfig(tabbyOptions.modelName, {
            draftMode: 'mtp',
            draftNumTokens: tabbyOptions.mtp.draftNumTokens,
            dynamicDraft: tabbyOptions.mtp.dynamicDraft
          })
        }

        const current = await tabbyClient.getCurrentModel()
        if (current && current.modelId !== tabbyOptions.modelName) {
          await tabbyClient.unloadModel()
        }

        for await (const progress of tabbyClient.loadModel(tabbyOptions)) {
          if (progress.status === 'finished') continue
        }
        logBuffer.appendApp('info', `[studio] tabby-load done ${tabbyOptions.modelName}`)
      },
      (loaded) => {
        this.loadedFingerprints.clear()
        this.loadedFingerprints.set(modelRefKey(ref), fingerprint)
        onLoaded?.(loaded)
      }
    )
  }

  unloadModel(_modelId: string): Promise<void> {
    this.loadedFingerprints.clear()
    return tabbyClient.unloadModel()
  }

  async testSpeed(modelId: string): Promise<ModelSpeedTestResult> {
    return (await tabbyClient.testSpeed(modelId)) as ModelSpeedTestResult
  }

  async checkForUpdate(_force = false): Promise<OllamaUpdateInfo> {
    return {
      current: 'TabbyAPI',
      latest: null,
      updateAvailable: false,
      releaseUrl: 'https://github.com/theroyallab/tabbyAPI/releases',
      checkedAt: Date.now()
    }
  }

  async deleteModel(_modelId: string): Promise<void> {
    throw new Error('Tabby katalog nepodporuje delete ze Studia')
  }

  async cloneModel(_source: string, _destination: string): Promise<void> {
    throw new Error('Tabby katalog nepodporuje clone ze Studia')
  }

  async pullModel(
    _modelId: string,
    _onProgress: (progress: PullProgress) => void
  ): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'Použijte HF download (tabbyDownload)' }
  }

  async killProcess(pid: number) {
    const managed = await this.getManagedPids()
    if (!managed.includes(pid) && pid !== this.getPid()) {
      return { ok: false, error: tMain('errors.notOllamaProcess', { pid, name: 'python' }) }
    }
    return killOllamaRelatedProcess(pid, {
      servePid: this.getPid(),
      stopServe: async () => {
        await this.stop()
      },
      allowAnyName: true,
      allowedPids: managed
    })
  }

  private async loadedSizes(): Promise<{ size: number; sizeVram: number }> {
    const managed = await this.getManagedPids()
    const pids = managed.length > 0 ? managed : this.getPid() == null ? [] : [this.getPid()!]
    return tabbyProcessSize(pids)
  }

  private assertStoppedForRuntimeLogOps(): void {
    const state = this.getServeState()
    if (
      state.processStatus === 'running' ||
      state.processStatus === 'starting' ||
      state.processStatus === 'external'
    ) {
      throw new Error('TABBY_RUNTIME_MUST_BE_STOPPED')
    }
  }
}

export const tabbyProvider = new TabbyProvider()
