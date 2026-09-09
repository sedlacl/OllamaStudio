import type {
  ModelShow,
  ModelSpeedTestResult,
  ModelTag,
  OllamaUpdateInfo,
  PullProgress,
  RunningModel
} from '../ollama/client'
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
import { tabbyProcessSize } from '../tabby/loaded-memory-live'
import { enrichTabbyModelSummaries } from '../tabby/local-model-info'
import { writeModelMtpConfig } from '../tabby/model-config'
import { preflightTabby, tabbyServeManager } from '../tabby/serve-manager'
import { TABBY_DEFAULT_CONTEXT_LENGTH } from '../ollama/opencode-config'
import { TABBY_CAPABILITIES, type BackendServeState } from './types'
import type { BackendLoadOptions, BackendProvider } from './provider'

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
  readonly displayName = 'TabbyAPI'
  readonly capabilities = TABBY_CAPABILITIES
  readonly logVendor = 'tabby' as const

  getServeState(): BackendServeState {
    return tabbyServeManager.getState()
  }

  isRunning(): boolean {
    return tabbyServeManager.isRunning()
  }

  async start(forceKillConflict = false): Promise<BackendServeState> {
    await tabbyServeManager.start(forceKillConflict)
    return this.getServeState()
  }

  async stop(): Promise<BackendServeState> {
    await tabbyServeManager.stop()
    return this.getServeState()
  }

  async restart(forceKillConflict = false): Promise<BackendServeState> {
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
    const tabbyOptions =
      options && 'modelName' in options
        ? (options as TabbyStudioLoadOptions)
        : ({ modelName: modelId, ...(options as object | undefined) } as TabbyStudioLoadOptions)
    if (!tabbyOptions.modelName) tabbyOptions.modelName = modelId

    recordLoadOptions(tabbyOptions.modelName, {
      keepAlive: '-1',
      numCtx: tabbyOptions.maxSeqLen ?? TABBY_DEFAULT_CONTEXT_LENGTH
    })

    return startBackgroundModelLoad(
      tabbyOptions.modelName,
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
      onLoaded
    )
  }

  unloadModel(_modelId: string): Promise<void> {
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
}

export const tabbyProvider = new TabbyProvider()
