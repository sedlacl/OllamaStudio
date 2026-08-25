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
import {
  ollamaClient,
  type ModelLoadOptions,
  type ModelSpeedTestResult,
  type ServeConnectionStatus
} from '../ollama/client'
import { loadConfig, saveConfig, type AppConfig } from '../ollama/config'
import {
  clearAllLoadOptions,
  getLoadOptions,
  removeLoadOptions
} from '../ollama/load-options-registry'
import { logBuffer, type LogEntry } from '../ollama/log-buffer'
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
import { isLocale, setMainLocale, tMain, type Locale } from '../i18n'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let loadedModelCount = 0
/** true = zavření okna aplikaci ukončí místo skrytí do tray. */
let isQuitting = false
/** Testy rychlosti běžící právě teď — dva naráz by si na runneru překážely. */
const speedTestsInFlight = new Set<string>()

async function runSpeedTest(name: string): Promise<ModelSpeedTestResult> {
  if (speedTestsInFlight.has(name)) {
    throw new Error(tMain('errors.speedTestRunning', { name }))
  }
  speedTestsInFlight.add(name)
  try {
    const result = await ollamaClient.testSpeed(name, getLoadOptions(name)?.options ?? null)
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
    if (!isQuitting) {
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
  const state = serveManager.getState()
  const statusLabel = statusText(state.status)
  tray.setToolTip(
    tMain('tray.tooltip', { status: statusLabel, count: loadedModelCount })
  )

  const menu = Menu.buildFromTemplate([
    { label: tMain('tray.show'), click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: state.status === 'running' ? tMain('tray.stopServe') : tMain('tray.startServe'),
      enabled: state.status !== 'starting' && state.status !== 'stopping',
      click: async () => {
        if (state.status === 'running') await serveManager.stop()
        else await serveManager.start()
        updateTrayMenu()
      }
    },
    {
      label: tMain('tray.restartServe'),
      enabled: state.status === 'running',
      click: async () => {
        await serveManager.restart()
        updateTrayMenu()
      }
    },
    { type: 'separator' },
    {
      label: tMain('tray.quit'),
      click: () => {
        isQuitting = true
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
  ipcMain.handle('get-serve-status', () => serveManager.getState())

  ipcMain.handle('get-app-version', () => app.getVersion())

  ipcMain.handle('get-resource-usage', async () => {
    const state = serveManager.getState()
    return collectResourceUsage(ollamaClient, serveManager.getPid(), state.status)
  })

  ipcMain.handle('kill-ollama-process', async (_e, pid: number) => {
    return killOllamaRelatedProcess(pid, {
      servePid: serveManager.getPid(),
      stopServe: () => serveManager.stop()
    })
  })

  ipcMain.handle('get-model-load-status', () => getActiveModelLoads())

  ipcMain.handle('get-dashboard', async () => {
    const state = serveManager.getState()
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
    return { ...metrics, connection }
  })

  ipcMain.handle('get-models-tags', () => ollamaClient.getTags())
  ipcMain.handle('get-models-ps', () => ollamaClient.getPs())
  ipcMain.handle('model-show', (_e, name: string) => ollamaClient.show(name))
  ipcMain.handle('model-load', (_e, name: string, options?: ModelLoadOptions) =>
    // Po načtení rovnou změříme rychlost, ať je v tabulce bez dalšího klikání.
    startModelLoad(ollamaClient, name, options, (loaded) => {
      void runSpeedTest(loaded).catch(() => {
        /* test je doplněk načtení, chybu uživateli nehlásíme */
      })
    })
  )
  ipcMain.handle('model-unload', async (_e, name: string) => {
    await ollamaClient.unload(name)
    removeLoadOptions(name)
    removeSpeedTest(name)
    mainWindow?.webContents.send('speed-tests-changed')
    clearModelLoadState(name)
  })
  ipcMain.handle('model-test-speed', (_e, name: string) => runSpeedTest(name))

  ipcMain.handle('get-speed-tests', () => getSpeedTests())

  ipcMain.handle('check-ollama-update', (_e, force?: boolean) =>
    ollamaClient.checkForUpdate({ force: force === true })
  )

  // Jen https odkazy, ať z rendereru nejde spustit lokální soubor ani jiný protokol.
  ipcMain.handle('open-external', async (_e, url: string) => {
    if (typeof url === 'string' && url.startsWith('https://')) {
      await shell.openExternal(url)
    }
  })

  ipcMain.handle('model-delete', async (_e, name: string) => {
    await ollamaClient.delete(name)
    removeLoadOptions(name)
    removeSpeedTest(name)
  })
  ipcMain.handle('model-copy', (_e, source: string, destination: string) =>
    ollamaClient.copy(source, destination)
  )
  ipcMain.handle('get-model-load-options', (_e, name: string) => getLoadOptions(name))

  ipcMain.handle('model-pull', async (event, name: string) => {
    try {
      for await (const progress of ollamaClient.pull(name)) {
        event.sender.send('pull-progress', { name, progress })
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('get-server-config', () => loadConfig())
  ipcMain.handle('save-server-config-and-restart', async (_e, config: AppConfig) => {
    const existing = loadConfig()
    const merged: AppConfig = {
      ...config,
      language:
        config.language === 'en' || config.language === 'cs'
          ? config.language
          : existing.language ?? 'cs'
    }
    syncLocaleFromConfig(merged)
    clearAllLoadOptions()
    clearAllSpeedTests()
    await serveManager.saveConfigAndRestart(merged)
    updateTrayMenu()
    return serveManager.getState()
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
    await serveManager.start(forceKillConflict ?? false)
    return serveManager.getState()
  })

  ipcMain.handle('stop-server', async () => {
    await serveManager.stop()
    clearAllLoadOptions()
    clearAllSpeedTests()
    return serveManager.getState()
  })

  ipcMain.handle('restart-server', async (_e, forceKillConflict?: boolean) => {
    clearAllLoadOptions()
    clearAllSpeedTests()
    await serveManager.restart(forceKillConflict ?? false)
    return serveManager.getState()
  })

  ipcMain.handle('get-logs', (_e, limit?: number) => logBuffer.getEntries(limit ?? 500))
  ipcMain.handle('clear-logs', () => {
    logBuffer.clear()
    return true
  })

  ipcMain.handle('detect-ollama-binary', () => serveManager.detectBinary())

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
  ipcMain.handle('continue-upsert-model', (_e, modelName: string) => upsertContinueModel(modelName))
  ipcMain.handle('continue-remove-model', (_e, modelName: string) => removeContinueModel(modelName))
  ipcMain.handle('integrations-status', (_e, modelNames?: string[]) =>
    getIntegrationsStatus(Array.isArray(modelNames) ? modelNames : [])
  )
  ipcMain.handle('opencode-upsert-model', (_e, modelName: string) => upsertOpenCodeModel(modelName))
  ipcMain.handle('opencode-remove-model', (_e, modelName: string) => removeOpenCodeModel(modelName))
}

app.whenReady().then(async () => {
  syncLocaleFromConfig()
  createWindow()
  initModelLoadManager(() => mainWindow)
  createTray()
  registerIpc()

  serveManager.subscribe((state) => {
    updateTrayMenu()
    if (state.status === 'stopped' || state.status === 'error') {
      clearAllLoadOptions()
      clearAllSpeedTests()
    }
  })

  logBuffer.subscribe((entry: LogEntry) => {
    mainWindow?.webContents.send('log-entry', entry)
    if (entry.category === 'request') {
      mainWindow?.webContents.send('dashboard-requests-changed')
    }
  })

  const config = loadConfig()
  if (config.autoStartServe) {
    await serveManager.start()
    updateTrayMenu()
  }
})

app.on('window-all-closed', () => {
  /* keep running in tray */
})

let quittingAfterShutdown = false

app.on('before-quit', (event) => {
  isQuitting = true
  if (quittingAfterShutdown) return
  event.preventDefault()
  quittingAfterShutdown = true
  void serveManager.shutdown().finally(() => {
    app.quit()
  })
})
