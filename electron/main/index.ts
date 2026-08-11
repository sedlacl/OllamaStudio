import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Tray
} from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { ollamaClient, type ModelLoadOptions } from '../ollama/client'
import { loadConfig, type AppConfig } from '../ollama/config'
import {
  clearAllLoadOptions,
  getLoadOptions,
  recordLoadOptions,
  removeLoadOptions
} from '../ollama/load-options-registry'
import { logBuffer, type LogEntry } from '../ollama/log-buffer'
import { collectMetrics } from '../ollama/metrics'
import { serveManager } from '../ollama/serve-manager'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let loadedModelCount = 0

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'OllamaStudio',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
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
  tray.setToolTip('OllamaStudio — zastaveno')
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
  tray.setToolTip(`OllamaStudio — ${statusLabel} | načteno: ${loadedModelCount}`)

  const menu = Menu.buildFromTemplate([
    { label: 'Zobrazit OllamaStudio', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: state.status === 'running' ? 'Zastavit serve' : 'Spustit serve',
      enabled: state.status !== 'starting' && state.status !== 'stopping',
      click: async () => {
        if (state.status === 'running') await serveManager.stop()
        else await serveManager.start()
        updateTrayMenu()
      }
    },
    {
      label: 'Restartovat serve',
      enabled: state.status === 'running',
      click: async () => {
        await serveManager.restart()
        updateTrayMenu()
      }
    },
    { type: 'separator' },
    {
      label: 'Ukončit OllamaStudio',
      click: () => {
        app.isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}

function statusText(status: string): string {
  switch (status) {
    case 'running':
      return 'běží'
    case 'starting':
      return 'spouští se'
    case 'stopping':
      return 'zastavuje se'
    case 'error':
      return 'chyba'
    default:
      return 'zastaveno'
  }
}

function registerIpc(): void {
  ipcMain.handle('get-serve-status', () => serveManager.getState())

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
    const connection = await ollamaClient.getConnectionStatus(state.status === 'running')
    return { ...metrics, connection }
  })

  ipcMain.handle('get-models-tags', () => ollamaClient.getTags())
  ipcMain.handle('get-models-ps', () => ollamaClient.getPs())
  ipcMain.handle('model-show', (_e, name: string) => ollamaClient.show(name))
  ipcMain.handle('model-load', async (_e, name: string, options?: ModelLoadOptions) => {
    const loadOptions = options ?? { keepAlive: '-1' }
    await ollamaClient.load(name, loadOptions)
    recordLoadOptions(name, loadOptions)
  })
  ipcMain.handle('model-unload', async (_e, name: string) => {
    await ollamaClient.unload(name)
    removeLoadOptions(name)
  })
  ipcMain.handle('model-delete', async (_e, name: string) => {
    await ollamaClient.delete(name)
    removeLoadOptions(name)
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
    clearAllLoadOptions()
    await serveManager.saveConfigAndRestart(config)
    return serveManager.getState()
  })

  ipcMain.handle('start-server', async (_e, forceKillConflict?: boolean) => {
    await serveManager.start(forceKillConflict ?? false)
    return serveManager.getState()
  })

  ipcMain.handle('stop-server', async () => {
    await serveManager.stop()
    clearAllLoadOptions()
    return serveManager.getState()
  })

  ipcMain.handle('restart-server', async (_e, forceKillConflict?: boolean) => {
    clearAllLoadOptions()
    await serveManager.restart(forceKillConflict ?? false)
    return serveManager.getState()
  })

  ipcMain.handle('get-logs', (_e, limit?: number) => logBuffer.getEntries(limit ?? 500))
  ipcMain.handle('clear-logs', () => {
    logBuffer.clear()
    return true
  })

  ipcMain.handle('detect-ollama-binary', () => serveManager.detectBinary())
}

app.whenReady().then(async () => {
  createWindow()
  createTray()
  registerIpc()

  serveManager.subscribe((state) => {
    updateTrayMenu()
    if (state.status === 'stopped' || state.status === 'error') {
      clearAllLoadOptions()
    }
  })

  logBuffer.subscribe((entry: LogEntry) => {
    mainWindow?.webContents.send('log-entry', entry)
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

app.on('before-quit', async () => {
  app.isQuitting = true
  await serveManager.shutdown()
})

declare module 'electron' {
  interface App {
    isQuitting?: boolean
  }
}
