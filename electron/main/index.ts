import { applyRemoteDebugPortIfEnabled } from './remote-debug-port'
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray
} from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { type ServeConnectionStatus } from '../ollama/client'
import {
  getActiveBackend,
  getBackendSettings,
  getMcpSettings,
  loadConfig,
  regenerateMcpToken,
  saveConfig,
  saveBackendSettings,
  saveMcpSettings,
  type AppConfig
} from '../ollama/config'
import { McpHttpServer } from '../mcp/http-server'
import { getMcpRuntimeState } from '../mcp/runtime-state'
import {
  deleteStudioModel,
  runModelSpeedTest
} from '../mcp/handlers'
import {
  clearAllLoadOptions,
  getLoadOptions
} from '../ollama/load-options-registry'
import { logBuffer, type LogEntry } from '../ollama/log-buffer'
import {
  clearStudioLogs,
  prepareStudioLogScrub
} from '../security/studio-log-persistence'
import { registerTabbyAuthSecrets, releaseTabbyAuthSecrets, watchTabbyAuth } from '../tabby/auth'
import {
  getActiveModelLoads,
  initModelLoadManager
} from '../ollama/model-load-manager'
import { collectMetrics, collectResourceUsage } from '../ollama/metrics'
import {
  getContinueConfigStatus,
  removeContinueModel,
  upsertContinueModel
} from '../ollama/continue-config'
import { getIntegrationsStatus } from '../ollama/integrations-status'
import {
  removeOpenCodeModel,
  upsertOpenCodeModel
} from '../ollama/opencode-config'
import {
  clearAllSpeedTests,
  getSpeedTests
} from '../ollama/speed-test-registry'
import {
  deletePreset,
  importPresetJson,
  listPresets,
  savePreset,
  type PresetKind
} from '../ollama/presets'
import {
  getActiveCapabilities,
  getUnifiedServeState,
  restartActiveBackend,
  saveConfigAndRestartActive,
  shutdownAllBackends,
  startActiveBackend,
  stopActiveBackend,
  switchActiveBackend
} from '../tabby/active-backend'
import {
  dismissDownloadSession,
  getDownloadStatusSnapshot,
  rememberDownloadForm,
  resanitizeDownloadSessionSnapshot
} from '../tabby/download-session'
import { type BackendId } from '../backends/types'
import {
  getActiveProvider,
  getAllProviders,
  getProvider,
  normalizeProviderId
} from '../backends/registry'
import { BACKEND_DESCRIPTORS } from '../backends/definitions'
import { modelProfileStore } from '../backends/model-profile-store'
import { modelCatalog } from '../backends/model-catalog'
import { modelCoordinator } from '../backends/model-coordinator'
import { modelAcquisitionManager } from '../backends/model-acquisition-manager'
import { invokeProviderAction } from '../backends/provider-actions'
import {
  type AcquisitionState,
  isBackendId,
  type ModelOperationRequest,
  type ModelRef
} from '../../shared/backend-contract'
import { isLocale, setMainLocale, tMain, type Locale } from '../i18n'
import { isAppQuitting, markAppQuitting } from '../ollama/app-lifecycle'
import {
  isQuietBackendPoll,
  logAndFormatIpcError,
  serializeIpcError,
  shouldIgnorePollFailure
} from '../ollama/ipc-error'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let loadedModelCount = 0
let tabbyAuthWatchRelease: (() => void) | null = null
const mcpHttpServer = new McpHttpServer(() => app.getVersion())

function activeBackendUrl(): string {
  return getActiveProvider().getBaseUrl()
}

function syncLogVendor(): void {
  logBuffer.setVendor(getActiveProvider().logVendor)
}

let legacyAcquisitionSequence = 0

function emitAcquisitionChanged(state: AcquisitionState): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('model-acquisition-changed', state)
  if (state.providerId === 'ollama') {
    mainWindow.webContents.send('pull-progress', {
      name: state.modelId,
      progress: {
        status: state.status,
        total: state.bytesTotal ?? undefined,
        completed: state.bytesDownloaded
      }
    })
    return
  }
  const details =
    state.details && typeof state.details === 'object'
      ? (state.details as Record<string, unknown>)
      : {}
  const repoId = typeof details.repoId === 'string' ? details.repoId : ''
  const revision = typeof details.revision === 'string' ? details.revision : ''
  const folderName =
    typeof details.folderName === 'string' ? details.folderName : state.modelId
  mainWindow.webContents.send('tabby-download-progress', {
    operationId: state.operationId,
    status:
      state.status === 'success'
        ? 'success'
        : state.status === 'running'
          ? 'running'
          : 'error',
    message: state.error,
    percent: state.percent,
    bytesDownloaded: state.bytesDownloaded,
    bytesTotal: state.bytesTotal
  })
  legacyAcquisitionSequence += 1
  mainWindow.webContents.send('tabby-download-status', {
    sequence: legacyAcquisitionSequence,
    session: {
      sequence: legacyAcquisitionSequence,
      operationId: state.operationId,
      status: state.status,
      repoId,
      revision,
      folderName,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      downloadedBytes: state.bytesDownloaded ?? 0,
      totalBytes: state.bytesTotal ?? null,
      percent: state.percent ?? null,
      error: state.error,
      folderConflict: details.folderConflict,
      dismissed: false,
      bytesPerSec: state.bytesPerSec,
      etaSeconds: state.etaSeconds
    },
    form: { repoId, revision, folderName }
  })
}

function syncLocaleFromConfig(config?: AppConfig): Locale {
  const cfg = config ?? loadConfig()
  const language: Locale = cfg.language === 'en' ? 'en' : 'cs'
  setMainLocale(language)
  return language
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })
}

function createWindow(): void {
  const windowTitle = `OllamaStudio ${app.getVersion()}`

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: windowTitle,
    icon: resolveTrayIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Bez preventDefault by <title> z rendereru přepsal titulek s verzí.
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
    mainWindow?.setTitle(windowTitle)
  })

  mainWindow.on('ready-to-show', () => {
    // Screenshoty (scripts/capture-screenshots.mjs) potřebují plnou šířku layoutu.
    if (process.env.OLLAMASTUDIO_START_MAXIMIZED === '1') mainWindow?.maximize()
    mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (!isAppQuitting()) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function resolveTrayIcon(): Electron.NativeImage {
  const relPaths =
    process.platform === 'win32'
      ? ['build/icon.ico', 'build/icon-256.png']
      : ['build/icon-256.png', 'build/icon.ico']

  const baseDirs = [join(__dirname, '../..'), app.getAppPath(), process.resourcesPath]

  for (const baseDir of baseDirs) {
    for (const relPath of relPaths) {
      const iconPath = join(baseDir, relPath)
      if (!existsSync(iconPath)) continue
      const image = nativeImage.createFromPath(iconPath)
      if (!image.isEmpty()) return image
    }
  }

  return nativeImage.createEmpty()
}

function createTray(): void {
  const icon = resolveTrayIcon()
  tray = new Tray(icon)
  updateTrayMenu()
  tray.on('double-click', () => showMainWindow())
}

function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function updateTrayMenu(): void {
  if (!tray) return
  const state = getUnifiedServeState()
  const provider = getActiveProvider()
  const statusLabel = statusText(state.status)
  tray.setToolTip(
    tMain('tray.tooltip', {
      status: `${provider.displayName}: ${statusLabel}`,
      count: loadedModelCount
    })
  )

  const menu = Menu.buildFromTemplate([
    { label: tMain('tray.show'), click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: state.status === 'running' ? tMain('tray.stopServe') : tMain('tray.startServe'),
      enabled: state.status !== 'starting' && state.status !== 'stopping',
      click: async () => {
        if (state.status === 'running') await stopActiveBackend()
        else await startActiveBackend()
        updateTrayMenu()
      }
    },
    {
      label: tMain('tray.restartServe'),
      enabled: state.status === 'running' && (state.ownedByStudio !== false),
      click: async () => {
        await restartActiveBackend()
        updateTrayMenu()
      }
    },
    { type: 'separator' },
    {
      label: tMain('tray.quit'),
      click: () => {
        markAppQuitting()
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

function deriveConnectionStatus(
  serveStatus: string,
  version: string | null
): ServeConnectionStatus {
  if (serveStatus !== 'running') return 'disconnected'
  if (version) return 'connected'
  return 'starting'
}

function statusText(status: string): string {
  switch (status) {
    case 'running':
      return tMain('tray.statusRunning')
    case 'starting':
      return tMain('tray.statusStarting')
    case 'stopping':
      return tMain('tray.statusStopping')
    case 'error':
      return tMain('tray.statusError')
    default:
      return tMain('tray.statusStopped')
  }
}

function registerIpc(): void {
  ipcMain.handle('get-backend-descriptors', () => Object.values(BACKEND_DESCRIPTORS))
  ipcMain.handle('get-backend-settings', (_e, id: unknown) => {
    if (!isBackendId(id)) throw new Error('Unknown backend')
    return getBackendSettings(id)
  })
  ipcMain.handle('save-backend-settings', (_e, id: unknown, patch: unknown) => {
    if (!isBackendId(id) || !patch || typeof patch !== 'object') {
      throw new Error('Invalid backend settings payload')
    }
    return saveBackendSettings(id, patch)
  })
  ipcMain.handle('get-model-profile', (_e, ref: ModelRef) => {
    if (!ref || !isBackendId(ref.providerId) || typeof ref.modelId !== 'string') {
      throw new Error('Invalid model reference')
    }
    return modelProfileStore.get(ref)
  })
  ipcMain.handle('save-model-profile', (_e, ref: ModelRef, profile: unknown) => {
    if (!ref || !isBackendId(ref.providerId) || typeof ref.modelId !== 'string') {
      throw new Error('Invalid model reference')
    }
    return modelProfileStore.save(ref, profile)
  })
  ipcMain.handle('get-serve-status', () => getUnifiedServeState())

  ipcMain.handle('get-app-version', () => app.getVersion())

  ipcMain.handle('get-backend-capabilities', () => getActiveCapabilities())

  ipcMain.handle('switch-backend', async (_e, backend: BackendId) => {
    const state = await switchActiveBackend(normalizeProviderId(backend))
    syncLogVendor()
    updateTrayMenu()
    return state
  })

  ipcMain.handle('tabby-preflight', () =>
    invokeProviderAction({
      providerId: 'tabby',
      action: 'runtime.preflight',
      payload: {}
    })
  )

  ipcMain.handle('get-resource-usage', async () => {
    const provider = getActiveProvider()
    const state = getUnifiedServeState()
    const managedPids = await provider.getManagedPids()
    const usage = await collectResourceUsage(
      provider.metricsClient(),
      provider.getPid(),
      state.status,
      { backend: provider.id, managedPids }
    )
    return {
      ...usage,
      backendProcesses: usage.ollamaProcesses,
      backendId: provider.id
    }
  })

  ipcMain.handle('kill-ollama-process', (_e, pid: number) =>
    getActiveProvider().killProcess(pid)
  )

  ipcMain.handle('get-model-load-status', () => getActiveModelLoads())
  ipcMain.handle('get-model-catalog', () => modelCatalog.refresh())
  ipcMain.handle('start-model-acquisition', (_e, request: unknown) =>
    modelAcquisitionManager.start(request as never)
  )
  ipcMain.handle('get-model-acquisitions', () =>
    modelAcquisitionManager.getAll()
  )
  ipcMain.handle('dismiss-model-acquisition', (_e, operationId: unknown) => {
    if (typeof operationId !== 'string') {
      throw new Error('Invalid acquisition operation')
    }
    return modelAcquisitionManager.dismiss(operationId)
  })
  ipcMain.handle('invoke-provider-action', (_e, request: unknown) =>
    invokeProviderAction(request)
  )

  ipcMain.handle('get-dashboard', async () => {
    const provider = getActiveProvider()
    const state = getUnifiedServeState()
    const skipHttp = isQuietBackendPoll(state.status)
    const client = skipHttp
      ? {
          getPs: async () => [],
          getVersion: async () => null
        }
      : provider.metricsClient()
    const metrics = await collectMetrics(
      client,
      provider.getPid(),
      provider.getSpawnTime(),
      () => logBuffer.getRollingTokensPerSec(),
      () => logBuffer.getActiveRequestEstimate(),
      () => logBuffer.getActiveRequests(),
      () => logBuffer.getRequestHistory(),
      state.status
    )
    loadedModelCount = metrics.loadedCount
    updateTrayMenu()
    const connection = deriveConnectionStatus(state.status, metrics.version)
    return { ...metrics, connection, backend: provider.id }
  })

  ipcMain.handle('get-models-tags', async () => {
    if (isQuietBackendPoll(getUnifiedServeState().status)) return []
    try {
      return await getActiveProvider().listModels()
    } catch (err) {
      if (shouldIgnorePollFailure(getUnifiedServeState().status)) return []
      throw serializeIpcError('get-models-tags', err, activeBackendUrl())
    }
  })

  ipcMain.handle('get-models-ps', async () => {
    if (isQuietBackendPoll(getUnifiedServeState().status)) return []
    try {
      return await getActiveProvider().listLoaded()
    } catch (err) {
      if (shouldIgnorePollFailure(getUnifiedServeState().status)) return []
      throw serializeIpcError('get-models-ps', err, activeBackendUrl())
    }
  })

  ipcMain.handle('model-show', async (_e, name: string) => {
    try {
      return await getActiveProvider().showModel(name)
    } catch (err) {
      throw serializeIpcError('model-show', err, activeBackendUrl())
    }
  })

  ipcMain.handle(
    'model-load',
    async (_e, request: ModelOperationRequest) => {
      const providerId = request?.ref?.providerId
      const provider = isBackendId(providerId) ? getProvider(providerId) : null
      if (!provider) throw new Error('Invalid model reference')
      const onLoaded = provider.capabilities.speedTestAutoAfterLoad
        ? (loaded: ModelRef) => {
            void runModelSpeedTest(loaded)
              .then(() => {
                mainWindow?.webContents.send('speed-tests-changed')
              })
              .catch(() => {
                /* test je doplněk načtení, chybu uživateli nehlásíme */
              })
          }
        : undefined
      return modelCoordinator.load(request, onLoaded)
    }
  )

  ipcMain.handle('model-unload', async (_e, ref: ModelRef) => {
    try {
      await modelCoordinator.unload(ref)
      mainWindow?.webContents.send('speed-tests-changed')
    } catch (err) {
      throw serializeIpcError('model-unload', err, activeBackendUrl())
    }
  })

  ipcMain.handle('model-test-speed', async (_e, ref: ModelRef) => {
    try {
      const result = await runModelSpeedTest(ref)
      mainWindow?.webContents.send('speed-tests-changed')
      return result
    } catch (err) {
      throw serializeIpcError('model-test-speed', err, activeBackendUrl())
    }
  })

  ipcMain.handle('get-speed-tests', () => getSpeedTests())

  ipcMain.handle('check-ollama-update', (_e, force?: boolean) =>
    getActiveProvider().checkForUpdate(force === true)
  )

  // Jen https odkazy, ať z rendereru nejde spustit lokální soubor ani jiný protokol.
  ipcMain.handle('open-external', async (_e, url: string) => {
    if (typeof url === 'string' && url.startsWith('https://')) {
      await shell.openExternal(url)
    }
  })

  ipcMain.handle('model-delete', async (_e, name: string) => {
    try {
      const provider = getActiveProvider()
      await deleteStudioModel({ providerId: provider.id, modelId: name })
    } catch (err) {
      throw serializeIpcError('model-delete', err, activeBackendUrl())
    }
  })

  ipcMain.handle('model-copy', async (_e, source: string, destination: string) => {
    try {
      return await getActiveProvider().cloneModel(source, destination)
    } catch (err) {
      throw serializeIpcError('model-copy', err, activeBackendUrl())
    }
  })

  ipcMain.handle('get-model-load-options', (_e, ref: ModelRef) => {
    if (!ref || !isBackendId(ref.providerId) || typeof ref.modelId !== 'string') {
      throw new Error('Invalid model reference')
    }
    return getLoadOptions(ref)
  })

  ipcMain.handle('model-pull', async (_event, name: string) => {
    try {
      const result = await modelAcquisitionManager.start({
        providerId: 'ollama',
        source: 'library',
        modelId: typeof name === 'string' ? name : ''
      })
      return { ok: result.ok, error: result.error }
    } catch (err) {
      return { ok: false, error: logAndFormatIpcError('model-pull', err, activeBackendUrl()) }
    }
  })

  ipcMain.handle(
    'tabby-hf-refs',
    async (
      _e,
      req: {
        repoId?: string
        token?: string
      }
    ) => {
      return invokeProviderAction({
        providerId: 'tabby',
        action: 'hf.refs',
        payload: {
          repoId: typeof req?.repoId === 'string' ? req.repoId : '',
          token: typeof req?.token === 'string' ? req.token : undefined
        }
      })
    }
  )

  ipcMain.handle(
    'tabby-download',
    async (
      event,
      req: {
        repoId: string
        revision?: string
        folderName?: string
        token?: string
      }
    ) => {
      void event
      const result = await modelAcquisitionManager.start({
        providerId: 'tabby',
        source: 'hugging-face',
        repoId: typeof req?.repoId === 'string' ? req.repoId : '',
        revision: typeof req?.revision === 'string' ? req.revision : undefined,
        folderName: typeof req?.folderName === 'string' ? req.folderName : undefined,
        token: typeof req?.token === 'string' ? req.token : undefined
      })
      const details =
        result.details && typeof result.details === 'object'
          ? (result.details as Record<string, unknown>)
          : {}
      return {
        ok: result.ok,
        error: result.error,
        alreadyRunning: result.alreadyRunning,
        downloadPath:
          typeof details.downloadPath === 'string' ? details.downloadPath : undefined,
        folderConflict: details.folderConflict
      }
    }
  )

  ipcMain.handle('tabby-download-status', () => getDownloadStatusSnapshot())
  ipcMain.handle('tabby-download-dismiss', async () => {
    const operationId = getDownloadStatusSnapshot().session?.operationId
    if (operationId) await modelAcquisitionManager.dismiss(operationId)
    else dismissDownloadSession()
    return getDownloadStatusSnapshot()
  })
  ipcMain.handle(
    'tabby-download-remember-form',
    (
      _e,
      req: {
        repoId?: string
        revision?: string
        folderName?: string
      }
    ) =>
      rememberDownloadForm({
        repoId: typeof req?.repoId === 'string' ? req.repoId : '',
        revision: typeof req?.revision === 'string' ? req.revision : '',
        folderName: typeof req?.folderName === 'string' ? req.folderName : ''
      })
  )

  ipcMain.handle('tabby-delete-download-folder', async (_e, folderName: unknown) => {
    return invokeProviderAction({
      providerId: 'tabby',
      action: 'download.delete-folder',
      payload: { folderName: typeof folderName === 'string' ? folderName : '' }
    })
  })

  ipcMain.handle('get-server-config', () => loadConfig())

  ipcMain.handle('get-mcp-settings', () => ({
    settings: getMcpSettings(),
    runtime: getMcpRuntimeState()
  }))

  ipcMain.handle('save-mcp-settings', async (_e, patch: unknown) => {
    const raw = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
    const next = saveMcpSettings({
      ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
      ...(typeof raw.port === 'number' && Number.isFinite(raw.port) ? { port: raw.port } : {})
    })
    await mcpHttpServer.applyConfig(next)
    return { settings: next, runtime: getMcpRuntimeState() }
  })

  ipcMain.handle('regenerate-mcp-token', async () => {
    const settings = regenerateMcpToken()
    await mcpHttpServer.applyConfig(settings)
    return { settings, runtime: getMcpRuntimeState() }
  })

  ipcMain.handle('save-server-config-and-restart', async (_e, config: AppConfig) => {
    const existing = loadConfig()
    const merged: AppConfig = {
      ...config,
      language:
        config.language === 'en' || config.language === 'cs'
          ? config.language
          : existing.language ?? 'cs',
      activeBackend:
        config.activeBackend === 'tabby' ? 'tabby' : existing.activeBackend ?? 'ollama',
      mcp: config.mcp ?? existing.mcp,
      tabby: config.tabby ?? existing.tabby
    }
    syncLocaleFromConfig(merged)
    clearAllLoadOptions()
    clearAllSpeedTests()
    const state = await saveConfigAndRestartActive(merged)
    await mcpHttpServer.applyConfig(getMcpSettings())
    syncLogVendor()
    updateTrayMenu()
    return state
  })

  ipcMain.handle('get-app-language', () => syncLocaleFromConfig())
  ipcMain.handle('set-app-language', (_e, language: unknown) => {
    const next: Locale = isLocale(language) ? language : 'cs'
    const config = loadConfig()
    config.language = next
    saveConfig(config)
    setMainLocale(next)
    updateTrayMenu()
    return next
  })

  ipcMain.handle('start-server', async (_e, forceKillConflict?: boolean) => {
    const state = await startActiveBackend(forceKillConflict ?? false)
    updateTrayMenu()
    return state
  })

  ipcMain.handle('stop-server', async () => {
    const state = await stopActiveBackend()
    updateTrayMenu()
    return state
  })

  ipcMain.handle('restart-server', async (_e, forceKillConflict?: boolean) => {
    const state = await restartActiveBackend(forceKillConflict ?? false)
    updateTrayMenu()
    return state
  })

  ipcMain.handle('get-logs', (_e, limit?: number) => logBuffer.getEntries(limit ?? 500))
  ipcMain.handle('clear-logs', async (_e, options?: { disk?: boolean }) => {
    await clearStudioLogs(join(app.getPath('userData'), 'logs'), options?.disk === true)
    return true
  })

  ipcMain.handle('scrub-tabby-runtime-logs', async () => {
    return invokeProviderAction({
      providerId: 'tabby',
      action: 'runtime.scrub-logs',
      payload: {}
    })
  })

  ipcMain.handle('delete-tabby-runtime-zip-logs', async (_e, zipPaths: string[]) => {
    return invokeProviderAction({
      providerId: 'tabby',
      action: 'runtime.delete-zip-logs',
      payload: { zipPaths: Array.isArray(zipPaths) ? zipPaths : [] }
    })
  })

  ipcMain.handle('detect-ollama-binary', () =>
    invokeProviderAction({
      providerId: 'ollama',
      action: 'runtime.detect-binary',
      payload: {}
    })
  )

  ipcMain.handle('presets-list', (_e, kind: PresetKind) => listPresets(kind))
  ipcMain.handle(
    'presets-save',
    (_e, kind: PresetKind, name: string, data: unknown, id?: string) =>
      savePreset(kind, name, data as never, id)
  )
  ipcMain.handle('presets-delete', (_e, kind: PresetKind, id: string) => deletePreset(kind, id))
  ipcMain.handle('presets-import', (_e, kind: PresetKind, json: string) =>
    importPresetJson(kind, json)
  )

  ipcMain.handle('continue-status', () => getContinueConfigStatus())
  ipcMain.handle('continue-upsert-model', (_e, ref: ModelRef) => {
    if (!ref || ref.providerId !== 'ollama' || typeof ref.modelId !== 'string') {
      throw new Error('Invalid model reference')
    }
    return upsertContinueModel(
      ref,
      modelProfileStore.get({ providerId: 'ollama', modelId: ref.modelId })
    )
  })
  ipcMain.handle('continue-remove-model', (_e, ref: ModelRef) => {
    if (!ref || ref.providerId !== 'ollama' || typeof ref.modelId !== 'string') {
      throw new Error('Invalid model reference')
    }
    return removeContinueModel(ref)
  })
  ipcMain.handle('integrations-status', (_e, refs?: ModelRef[]) =>
    getIntegrationsStatus(
      Array.isArray(refs)
        ? refs.filter(
            (ref): ref is ModelRef =>
              Boolean(
                ref &&
                  (ref.providerId === 'ollama' || ref.providerId === 'tabby') &&
                  typeof ref.modelId === 'string'
              )
          )
        : []
    )
  )
  ipcMain.handle('opencode-upsert-model', (_e, ref: ModelRef) => {
    if (
      !ref ||
      (ref.providerId !== 'ollama' && ref.providerId !== 'tabby') ||
      typeof ref.modelId !== 'string'
    ) {
      throw new Error('Invalid model reference')
    }
    return upsertOpenCodeModel(ref, modelProfileStore.get(ref))
  })
  ipcMain.handle('opencode-remove-model', (_e, ref: ModelRef) => {
    if (
      !ref ||
      (ref.providerId !== 'ollama' && ref.providerId !== 'tabby') ||
      typeof ref.modelId !== 'string'
    ) {
      throw new Error('Invalid model reference')
    }
    return removeOpenCodeModel(ref)
  })
}

applyRemoteDebugPortIfEnabled()

app.whenReady().then(async () => {
  syncLocaleFromConfig()
  syncLogVendor()
  const logsDir = join(app.getPath('userData'), 'logs')
  if (getActiveBackend() === 'tabby') {
    registerTabbyAuthSecrets()
    tabbyAuthWatchRelease = watchTabbyAuth(() => {
      resanitizeDownloadSessionSnapshot()
    })
  }
  await prepareStudioLogScrub(logsDir)
  createWindow()
  initModelLoadManager(() => mainWindow)
  await modelAcquisitionManager.initialize(
    app.getPath('userData'),
    emitAcquisitionChanged
  )
  createTray()
  registerIpc()
  await mcpHttpServer.applyConfig(getMcpSettings())

  for (const provider of getAllProviders()) {
    provider.subscribe(() => {
      if (getActiveBackend() === provider.id) updateTrayMenu()
    })
  }

  logBuffer.subscribe((entry: LogEntry) => {
    mainWindow?.webContents.send('log-entry', entry)
    if (entry.category === 'request') {
      mainWindow?.webContents.send('dashboard-requests-changed')
    }
  })

  const config = loadConfig()
  const provider = getActiveProvider()
  const autoStart = provider.shouldAutoStart(config)
  if (autoStart) {
    await provider.start()
    updateTrayMenu()
  } else {
    await provider.activate(false)
    updateTrayMenu()
  }
})

app.on('window-all-closed', () => {
  /* keep running in tray */
})

let quittingAfterShutdown = false

app.on('before-quit', (event) => {
  markAppQuitting()
  tabbyAuthWatchRelease?.()
  tabbyAuthWatchRelease = null
  releaseTabbyAuthSecrets()
  if (quittingAfterShutdown) return
  event.preventDefault()
  quittingAfterShutdown = true
  void Promise.all([
    shutdownAllBackends(),
    mcpHttpServer.stop()
  ]).finally(() => {
    app.quit()
  })
})
