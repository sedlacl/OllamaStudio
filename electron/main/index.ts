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
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  type ModelSpeedTestResult,
  type ServeConnectionStatus
} from '../ollama/client'
import {
  getActiveBackend,
  loadConfig,
  resolveTabbyModelDir,
  saveConfig,
  DEFAULT_TABBY_CONFIG,
  type AppConfig
} from '../ollama/config'
import {
  clearAllLoadOptions,
  getLoadOptions,
  removeLoadOptions
} from '../ollama/load-options-registry'
import { logBuffer, type LogEntry } from '../ollama/log-buffer'
import { scrubTabbyRuntimeTextLogs, deleteTabbyRuntimeZipLogs } from '../security/log-scrub'
import {
  clearStudioLogs,
  prepareStudioLogScrub,
  withBackendLogMutex
} from '../security/studio-log-persistence'
import {
  sanitizePullProgress,
  sanitizeSpeedTestResult
} from '../security/sanitize-state'
import { registerTabbyAuthSecrets, releaseTabbyAuthSecrets, watchTabbyAuth } from '../tabby/auth'
import {
  clearModelLoadState,
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
  getSpeedTests,
  recordSpeedTest,
  removeSpeedTest
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
  preflightTabby,
  restartActiveBackend,
  saveConfigAndRestartActive,
  shutdownAllBackends,
  startActiveBackend,
  stopActiveBackend,
  switchActiveBackend
} from '../tabby/active-backend'
import { tabbyClient } from '../tabby/client'
import { hfErrorToMessage, runTabbyHfDownload, deleteTabbyDownloadFolder, type TabbyDownloadProgressEvent } from '../tabby/hf-download'
import { invalidateLocalModelCache } from '../tabby/local-model-info'
import { directoryByteSize, fetchHfRevisions } from '../tabby/hf-hub'
import { tabbyServeManager } from '../tabby/serve-manager'
import {
  configureDownloadSession,
  dismissDownloadSession,
  getDownloadStatusSnapshot,
  recoverPersistedDownload,
  rememberDownloadForm,
  resanitizeDownloadSessionSnapshot
} from '../tabby/download-session'
import { type BackendId } from '../backends/types'
import {
  getActiveProvider,
  getAllProviders,
  normalizeProviderId
} from '../backends/registry'
import type { BackendLoadOptions } from '../backends/provider'
import { isLocale, setMainLocale, tMain, type Locale } from '../i18n'
import { isAppQuitting, markAppQuitting } from '../ollama/app-lifecycle'
import {
  isQuietBackendPoll,
  logAndFormatIpcError,
  logIpcError,
  serializeIpcError,
  shouldIgnorePollFailure
} from '../ollama/ipc-error'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let loadedModelCount = 0
let tabbyAuthWatchRelease: (() => void) | null = null
/** Testy rychlosti běžící právě teď — dva naráz by si na runneru překážely. */
const speedTestsInFlight = new Set<string>()

function activeBackendUrl(): string {
  return getActiveProvider().getBaseUrl()
}

function syncLogVendor(): void {
  logBuffer.setVendor(getActiveProvider().logVendor)
}

async function runSpeedTest(name: string): Promise<ModelSpeedTestResult> {
  if (speedTestsInFlight.has(name)) {
    throw new Error(tMain('errors.speedTestRunning', { name }))
  }
  speedTestsInFlight.add(name)
  try {
    const result = sanitizeSpeedTestResult(
      await getActiveProvider().testSpeed(name)
    )
    recordSpeedTest(name, result)
    mainWindow?.webContents.send('speed-tests-changed')
    return result
  } finally {
    speedTestsInFlight.delete(name)
  }
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
  ipcMain.handle('get-serve-status', () => getUnifiedServeState())

  ipcMain.handle('get-app-version', () => app.getVersion())

  ipcMain.handle('get-backend-capabilities', () => getActiveCapabilities())

  ipcMain.handle('switch-backend', async (_e, backend: BackendId) => {
    const state = await switchActiveBackend(normalizeProviderId(backend))
    syncLogVendor()
    updateTrayMenu()
    return state
  })

  ipcMain.handle('tabby-preflight', () => preflightTabby())

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
    async (_e, name: string, options?: BackendLoadOptions) => {
      const provider = getActiveProvider()
      const onLoaded = provider.capabilities.speedTestAutoAfterLoad
        ? (loaded: string) => {
            void runSpeedTest(loaded).catch(() => {
              /* test je doplněk načtení, chybu uživateli nehlásíme */
            })
          }
        : undefined
      return provider.loadModel(name, options, onLoaded)
    }
  )

  ipcMain.handle('model-unload', async (_e, name: string) => {
    try {
      await getActiveProvider().unloadModel(name)
      removeLoadOptions(name)
      removeSpeedTest(name)
      mainWindow?.webContents.send('speed-tests-changed')
      clearModelLoadState(name)
    } catch (err) {
      throw serializeIpcError('model-unload', err, activeBackendUrl())
    }
  })

  ipcMain.handle('model-test-speed', async (_e, name: string) => {
    try {
      return await runSpeedTest(name)
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
      await getActiveProvider().deleteModel(name)
      removeLoadOptions(name)
      removeSpeedTest(name)
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

  ipcMain.handle('get-model-load-options', (_e, name: string) => getLoadOptions(name))

  ipcMain.handle('model-pull', async (event, name: string) => {
    try {
      return await getActiveProvider().pullModel(name, (progress) => {
        event.sender.send('pull-progress', { name, progress: sanitizePullProgress(progress) })
      })
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
      const repoId = typeof req?.repoId === 'string' ? req.repoId.trim() : ''
      if (!repoId) return { ok: false, error: tMain('errors.hfRepoIdEmpty') }
      const token =
        typeof req?.token === 'string' && req.token.trim() ? req.token.trim() : undefined
      try {
        const revisions = await fetchHfRevisions(repoId, token)
        return { ok: true, revisions }
      } catch (err) {
        logIpcError('tabby-hf-refs', err)
        return { ok: false, error: hfErrorToMessage(err) }
      }
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
      const operationId = `dl-${Date.now().toString(36)}`
      const cfg = loadConfig()
      const modelDir = resolveTabbyModelDir(cfg.tabby ?? DEFAULT_TABBY_CONFIG)
      const emit = (payload: TabbyDownloadProgressEvent): void => {
        try {
          if (!event.sender.isDestroyed()) {
            event.sender.send('tabby-download-progress', payload)
          }
        } catch {
          /* ignore */
        }
      }
      try {
        await tabbyServeManager.ensureReady(180_000)
      } catch (err) {
        logIpcError('tabby-download-readiness', err)
        return { ok: false, error: tMain('errors.tabbyDownloadNotReady') }
      }
      return runTabbyHfDownload({
        req: {
          repoId: typeof req?.repoId === 'string' ? req.repoId : '',
          revision: typeof req?.revision === 'string' ? req.revision : undefined,
          folderName: typeof req?.folderName === 'string' ? req.folderName : undefined,
          token: typeof req?.token === 'string' ? req.token : undefined
        },
        operationId,
        modelDir,
        emit,
        download: (downloadReq) => tabbyClient.downloadModel(downloadReq)
      })
    }
  )

  ipcMain.handle('tabby-download-status', () => getDownloadStatusSnapshot())
  ipcMain.handle('tabby-download-dismiss', () => dismissDownloadSession())
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
    const name = typeof folderName === 'string' ? folderName : ''
    const cfg = loadConfig()
    const modelDir = resolveTabbyModelDir(cfg.tabby ?? DEFAULT_TABBY_CONFIG)
    const result = await deleteTabbyDownloadFolder(modelDir, name)
    if (result.ok) invalidateLocalModelCache(name)
    return result
  })

  ipcMain.handle('get-server-config', () => loadConfig())
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
      tabby: config.tabby ?? existing.tabby
    }
    syncLocaleFromConfig(merged)
    clearAllLoadOptions()
    clearAllSpeedTests()
    const state = await saveConfigAndRestartActive(merged)
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

  function assertTabbyStoppedForRuntimeLogOps(): void {
    const state = tabbyServeManager.getState()
    if (
      state.processStatus === 'running' ||
      state.processStatus === 'starting' ||
      state.processStatus === 'external'
    ) {
      throw new Error('TabbyAPI must be fully stopped (not external) before runtime log operations')
    }
  }

  ipcMain.handle('scrub-tabby-runtime-logs', async () => {
    return withBackendLogMutex(async () => {
      assertTabbyStoppedForRuntimeLogOps()
      const cfg = loadConfig().tabby ?? DEFAULT_TABBY_CONFIG
      return scrubTabbyRuntimeTextLogs(cfg.installDir)
    })
  })

  ipcMain.handle('delete-tabby-runtime-zip-logs', async (_e, zipPaths: string[]) => {
    return withBackendLogMutex(async () => {
      assertTabbyStoppedForRuntimeLogOps()
      const cfg = loadConfig().tabby ?? DEFAULT_TABBY_CONFIG
      if (!Array.isArray(zipPaths) || zipPaths.length === 0) {
        return { deleted: [], errors: [] as string[] }
      }
      return deleteTabbyRuntimeZipLogs(cfg.installDir, zipPaths)
    })
  })

  ipcMain.handle('detect-ollama-binary', () => getActiveProvider().detectBinary())

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
  ipcMain.handle('continue-upsert-model', (_e, modelName: string) => {
    if (!getActiveProvider().capabilities.continueIntegration) {
      throw new Error('Continue je v této verzi jen pro Ollamu')
    }
    return upsertContinueModel(modelName)
  })
  ipcMain.handle('continue-remove-model', (_e, modelName: string) => removeContinueModel(modelName))
  ipcMain.handle('integrations-status', (_e, modelNames?: string[]) =>
    getIntegrationsStatus(Array.isArray(modelNames) ? modelNames : [])
  )
  ipcMain.handle('opencode-upsert-model', (_e, modelName: string) => upsertOpenCodeModel(modelName))
  ipcMain.handle('opencode-remove-model', (_e, modelName: string) => removeOpenCodeModel(modelName))
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
  configureDownloadSession({
    persistFile: join(app.getPath('userData'), 'tabby-download.json'),
    log: (level, text) => logBuffer.appendApp(level, text),
    emit: (snapshot) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tabby-download-status', snapshot)
        }
      } catch {
        /* ignore */
      }
    }
  })
  const startupConfig = loadConfig()
  const modelDir = resolveTabbyModelDir(startupConfig.tabby ?? DEFAULT_TABBY_CONFIG)
  await recoverPersistedDownload({
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
  createTray()
  registerIpc()

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
  void shutdownAllBackends().finally(() => {
    app.quit()
  })
})
