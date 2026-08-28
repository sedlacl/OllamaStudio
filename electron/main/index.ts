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
  ollamaClient,
  type ModelLoadOptions,
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
import { sanitizeUnknownError } from '../security/sanitize-state'
import { registerTabbyAuthSecrets, releaseTabbyAuthSecrets, watchTabbyAuth } from '../tabby/auth'
import {
  clearModelLoadState,
  getActiveModelLoads,
  initModelLoadManager,
  startModelLoad
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
import { killOllamaRelatedProcess } from '../ollama/kill-process'
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
import { serveManager } from '../ollama/serve-manager'
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
import { tabbyClient, type TabbyLoadOptions } from '../tabby/client'
import { hfErrorToMessage, runTabbyHfDownload, deleteTabbyDownloadFolder, type TabbyDownloadProgressEvent } from '../tabby/hf-download'
import { directoryByteSize, fetchHfRevisions } from '../tabby/hf-hub'
import { writeModelMtpConfig } from '../tabby/model-config'
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
  return getActiveBackend() === 'tabby' ? tabbyClient.getBaseUrl() : ollamaClient.getBaseUrl()
}

function syncLogVendor(): void {
  logBuffer.setVendor(getActiveBackend() === 'tabby' ? 'tabby' : 'ollama')
}

async function runSpeedTest(name: string): Promise<ModelSpeedTestResult> {
  if (speedTestsInFlight.has(name)) {
    throw new Error(tMain('errors.speedTestRunning', { name }))
  }
  speedTestsInFlight.add(name)
  try {
    const backend = getActiveBackend()
    const result =
      backend === 'tabby'
        ? ((await tabbyClient.testSpeed(name)) as unknown as ModelSpeedTestResult)
        : await ollamaClient.testSpeed(name, getLoadOptions(name)?.options ?? null)
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
  const backend = getActiveBackend()
  const statusLabel = statusText(state.status)
  const backendLabel = backend === 'tabby' ? 'TabbyAPI' : 'Ollama'
  tray.setToolTip(
    tMain('tray.tooltip', { status: `${backendLabel}: ${statusLabel}`, count: loadedModelCount })
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

function tagsFromTabby(
  models: Awaited<ReturnType<typeof tabbyClient.listModels>>
): Array<{
  name: string
  model: string
  modified_at: string
  size: number
  digest: string
  details?: Record<string, string>
}> {
  return models.map((m) => ({
    name: m.modelId,
    model: m.modelId,
    modified_at: m.modifiedAt ?? new Date().toISOString(),
    size: m.sizeBytes ?? 0,
    digest: m.digest ?? '',
    details: {
      format: m.format ?? 'exl3',
      family: m.family ?? '',
      parameter_size: m.parameterSize ?? '',
      quantization_level: m.quantization ?? ''
    }
  }))
}

async function startTabbyModelLoad(
  options: TabbyLoadOptions & {
    mtp?: { enabled: boolean; draftNumTokens?: number; dynamicDraft?: boolean }
  }
): Promise<{ ok: boolean; error?: string }> {
  const name = options.modelName
  try {
    if (options.mtp?.enabled) {
      writeModelMtpConfig(name, {
        draftMode: 'mtp',
        draftNumTokens: options.mtp.draftNumTokens,
        dynamicDraft: options.mtp.dynamicDraft
      })
    }

    const current = await tabbyClient.getCurrentModel()
    if (current && current.modelId !== name) {
      await tabbyClient.unloadModel()
    }

    for await (const progress of tabbyClient.loadModel(options)) {
      mainWindow?.webContents.send('model-load-status', {
        name,
        status: 'loading',
        startedAt: Date.now(),
        error: undefined,
        progress
      })
    }

    mainWindow?.webContents.send('model-load-status', {
      name,
      status: 'success',
      startedAt: Date.now()
    })
    return { ok: true }
  } catch (err) {
    const error = sanitizeUnknownError(err)
    mainWindow?.webContents.send('model-load-status', {
      name,
      status: 'error',
      error,
      startedAt: Date.now()
    })
    return { ok: false, error }
  }
}

function registerIpc(): void {
  ipcMain.handle('get-serve-status', () => getUnifiedServeState())

  ipcMain.handle('get-app-version', () => app.getVersion())

  ipcMain.handle('get-backend-capabilities', () => getActiveCapabilities())

  ipcMain.handle('switch-backend', async (_e, backend: BackendId) => {
    const state = await switchActiveBackend(backend === 'tabby' ? 'tabby' : 'ollama')
    syncLogVendor()
    updateTrayMenu()
    return state
  })

  ipcMain.handle('tabby-preflight', () => preflightTabby())

  ipcMain.handle('get-resource-usage', async () => {
    const backend = getActiveBackend()
    const state = getUnifiedServeState()
    if (backend === 'tabby') {
      const managedPids = await tabbyServeManager.getManagedPids()
      const usage = await collectResourceUsage(
        {
          getPs: async () => {
            const current = await tabbyClient.getCurrentModel().catch(() => null)
            if (!current) return []
            return [
              {
                name: current.modelId,
                model: current.modelId,
                size: current.sizeBytes ?? 0,
                size_vram: current.sizeVramBytes ?? 0,
                digest: '',
                expires_at: ''
              }
            ]
          }
        } as never,
        state.pid,
        state.status,
        { backend: 'tabby', managedPids }
      )
      return {
        ...usage,
        backendProcesses: usage.ollamaProcesses,
        backendId: 'tabby' as const
      }
    }
    const usage = await collectResourceUsage(ollamaClient, serveManager.getPid(), state.status)
    return {
      ...usage,
      backendProcesses: usage.ollamaProcesses,
      backendId: 'ollama' as const
    }
  })

  ipcMain.handle('kill-ollama-process', async (_e, pid: number) => {
    const backend = getActiveBackend()
    if (backend === 'tabby') {
      const managed = await tabbyServeManager.getManagedPids()
      if (!managed.includes(pid) && pid !== tabbyServeManager.getPid()) {
        return { ok: false, error: tMain('errors.notOllamaProcess', { pid, name: 'python' }) }
      }
      if (pid === tabbyServeManager.getPid()) {
        await stopActiveBackend()
        return { ok: true }
      }
      return killOllamaRelatedProcess(pid, {
        servePid: tabbyServeManager.getPid(),
        stopServe: async () => {
          await stopActiveBackend()
        },
        allowAnyName: true,
        allowedPids: managed
      })
    }
    return killOllamaRelatedProcess(pid, {
      servePid: serveManager.getPid(),
      stopServe: async () => {
        await stopActiveBackend()
      }
    })
  })

  ipcMain.handle('get-model-load-status', () => getActiveModelLoads())

  ipcMain.handle('get-dashboard', async () => {
    const backend = getActiveBackend()
    const state = getUnifiedServeState()
    const skipHttp = isQuietBackendPoll(state.status)

    if (backend === 'tabby') {
      const current = skipHttp ? null : await tabbyClient.getCurrentModel().catch(() => null)
      const health = skipHttp ? null : await tabbyClient.getHealth().catch(() => null)
      const loadedModels = current
        ? [
            {
              name: current.modelId,
              sizeVram: current.sizeVramBytes ?? 0,
              size: current.sizeBytes ?? 0
            }
          ]
        : []
      loadedModelCount = loadedModels.length
      updateTrayMenu()
      const metrics = await collectMetrics(
        {
          getPs: async () =>
            loadedModels.map((m) => ({
              name: m.name,
              model: m.name,
              size: m.size,
              size_vram: m.sizeVram,
              digest: '',
              expires_at: ''
            })),
          getVersion: async () => (health ? 'TabbyAPI' : null)
        } as never,
        state.pid,
        state.spawnTime,
        () => logBuffer.getRollingTokensPerSec(),
        () => logBuffer.getActiveRequestEstimate(),
        () => logBuffer.getActiveRequests(),
        () => logBuffer.getRequestHistory(),
        state.status
      )
      const connection = deriveConnectionStatus(state.status, metrics.version)
      return { ...metrics, connection, backend: 'tabby' }
    }

    const metrics = await collectMetrics(
      ollamaClient,
      serveManager.getPid(),
      serveManager.getSpawnTime(),
      () => logBuffer.getRollingTokensPerSec(),
      () => logBuffer.getActiveRequestEstimate(),
      () => logBuffer.getActiveRequests(),
      () => logBuffer.getRequestHistory(),
      state.status
    )
    loadedModelCount = metrics.loadedCount
    updateTrayMenu()
    const connection = deriveConnectionStatus(state.status, metrics.version)
    return { ...metrics, connection, backend: 'ollama' }
  })

  ipcMain.handle('get-models-tags', async () => {
    if (isQuietBackendPoll(getUnifiedServeState().status)) return []
    try {
      if (getActiveBackend() === 'tabby') {
        tabbyClient.refresh()
        return tagsFromTabby(await tabbyClient.listModels())
      }
      return ollamaClient.getTags()
    } catch (err) {
      if (shouldIgnorePollFailure(getUnifiedServeState().status)) return []
      throw serializeIpcError('get-models-tags', err, activeBackendUrl())
    }
  })

  ipcMain.handle('get-models-ps', async () => {
    if (isQuietBackendPoll(getUnifiedServeState().status)) return []
    try {
      if (getActiveBackend() === 'tabby') {
        const current = await tabbyClient.getCurrentModel()
        if (!current) return []
        return [
          {
            name: current.modelId,
            model: current.modelId,
            size: current.sizeBytes ?? 0,
            size_vram: current.sizeVramBytes ?? 0,
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
      return ollamaClient.getPs()
    } catch (err) {
      if (shouldIgnorePollFailure(getUnifiedServeState().status)) return []
      throw serializeIpcError('get-models-ps', err, activeBackendUrl())
    }
  })

  ipcMain.handle('model-show', async (_e, name: string) => {
    if (getActiveBackend() === 'tabby') {
      return {
        details: { format: 'exl3' },
        model_info: { 'general.architecture': 'exl3' },
        capabilities: ['completion']
      }
    }
    try {
      return await ollamaClient.show(name)
    } catch (err) {
      throw serializeIpcError('model-show', err, activeBackendUrl())
    }
  })

  ipcMain.handle(
    'model-load',
    async (_e, name: string, options?: ModelLoadOptions | TabbyLoadOptions) => {
      if (getActiveBackend() === 'tabby') {
        const tabbyOpts =
          options && 'modelName' in (options as object)
            ? (options as TabbyLoadOptions)
            : ({
                modelName: name,
                ...(options as object)
              } as TabbyLoadOptions)
        if (!tabbyOpts.modelName) tabbyOpts.modelName = name
        return startTabbyModelLoad(tabbyOpts)
      }
      return startModelLoad(ollamaClient, name, options as ModelLoadOptions | undefined, (loaded) => {
        void runSpeedTest(loaded).catch(() => {
          /* test je doplněk načtení, chybu uživateli nehlásíme */
        })
      })
    }
  )

  ipcMain.handle('model-unload', async (_e, name: string) => {
    try {
      if (getActiveBackend() === 'tabby') {
        await tabbyClient.unloadModel()
        removeSpeedTest(name)
        mainWindow?.webContents.send('speed-tests-changed')
        clearModelLoadState(name)
        return
      }
      await ollamaClient.unload(name)
      removeLoadOptions(name)
      removeSpeedTest(name)
      mainWindow?.webContents.send('speed-tests-changed')
      clearModelLoadState(name)
    } catch (err) {
      throw serializeIpcError('model-unload', err, activeBackendUrl())
    }
  })

  ipcMain.handle('model-test-speed', (_e, name: string) => runSpeedTest(name))

  ipcMain.handle('get-speed-tests', () => getSpeedTests())

  ipcMain.handle('check-ollama-update', (_e, force?: boolean) =>
    getActiveBackend() === 'tabby'
      ? {
          current: 'TabbyAPI',
          latest: null,
          updateAvailable: false,
          releaseUrl: 'https://github.com/theroyallab/tabbyAPI/releases',
          checkedAt: Date.now()
        }
      : ollamaClient.checkForUpdate({ force: force === true })
  )

  // Jen https odkazy, ať z rendereru nejde spustit lokální soubor ani jiný protokol.
  ipcMain.handle('open-external', async (_e, url: string) => {
    if (typeof url === 'string' && url.startsWith('https://')) {
      await shell.openExternal(url)
    }
  })

  ipcMain.handle('model-delete', async (_e, name: string) => {
    if (getActiveBackend() === 'tabby') {
      throw new Error('Tabby katalog nepodporuje delete ze Studia')
    }
    try {
      await ollamaClient.delete(name)
      removeLoadOptions(name)
      removeSpeedTest(name)
    } catch (err) {
      throw serializeIpcError('model-delete', err, activeBackendUrl())
    }
  })

  ipcMain.handle('model-copy', async (_e, source: string, destination: string) => {
    if (getActiveBackend() === 'tabby') {
      throw new Error('Tabby katalog nepodporuje clone ze Studia')
    }
    try {
      return await ollamaClient.copy(source, destination)
    } catch (err) {
      throw serializeIpcError('model-copy', err, activeBackendUrl())
    }
  })

  ipcMain.handle('get-model-load-options', (_e, name: string) => getLoadOptions(name))

  ipcMain.handle('model-pull', async (event, name: string) => {
    if (getActiveBackend() === 'tabby') {
      return { ok: false, error: 'Použijte HF download (tabbyDownload)' }
    }
    try {
      for await (const progress of ollamaClient.pull(name)) {
        event.sender.send('pull-progress', { name, progress })
      }
      return { ok: true }
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
    return deleteTabbyDownloadFolder(modelDir, name)
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

  ipcMain.handle('detect-ollama-binary', () => {
    if (getActiveBackend() === 'tabby') {
      const pre = preflightTabby()
      return pre.pythonPath
    }
    return serveManager.detectBinary()
  })

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
    if (getActiveBackend() === 'tabby') {
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

  serveManager.subscribe(() => {
    if (getActiveBackend() === 'ollama') updateTrayMenu()
  })
  tabbyServeManager.subscribe(() => {
    if (getActiveBackend() === 'tabby') updateTrayMenu()
  })

  logBuffer.subscribe((entry: LogEntry) => {
    mainWindow?.webContents.send('log-entry', entry)
    if (entry.category === 'request') {
      mainWindow?.webContents.send('dashboard-requests-changed')
    }
  })

  const config = loadConfig()
  const backend = getActiveBackend(config)
  const autoStart =
    backend === 'tabby' ? Boolean(config.tabby?.autoStartServe) : config.autoStartServe
  if (autoStart) {
    await startActiveBackend()
    updateTrayMenu()
  } else if (backend === 'tabby') {
    await tabbyServeManager.adoptOrDetect()
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
