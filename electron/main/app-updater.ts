import { app } from 'electron'
import { autoUpdater, type AppUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { AppUpdateState } from '../../src/types/api'
import { sanitizeUnknownError } from '../security/sanitize-state'

type StateListener = (state: AppUpdateState) => void

function supportedInstallation(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'win32') return true
  return process.platform === 'linux' && Boolean(process.env.APPIMAGE)
}

export class StudioAppUpdater {
  private initialized = false
  private checking: Promise<AppUpdateState> | null = null
  private listeners = new Set<StateListener>()
  private state: AppUpdateState = {
    status: 'idle',
    currentVersion: app.getVersion(),
    latestVersion: null,
    releaseName: null,
    releaseUrl: null,
    progressPercent: null,
    error: null
  }

  constructor(private readonly updater: AppUpdater = autoUpdater) {}

  getState(): AppUpdateState {
    this.initialize()
    return { ...this.state }
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async check(): Promise<AppUpdateState> {
    this.initialize()
    if (!supportedInstallation()) {
      this.setState({ status: 'unsupported' })
      return this.getState()
    }
    if (this.checking) return this.checking

    this.setState({ status: 'checking', error: null })
    this.checking = this.updater
      .checkForUpdates()
      .then(() => this.getState())
      .catch((error: unknown) => {
        this.setState({ status: 'error', error: sanitizeUnknownError(error) })
        return this.getState()
      })
      .finally(() => {
        this.checking = null
      })
    return this.checking
  }

  async install(): Promise<AppUpdateState> {
    this.initialize()
    if (this.state.status !== 'available') {
      return this.getState()
    }
    try {
      this.setState({ status: 'downloading', progressPercent: 0, error: null })
      await this.updater.downloadUpdate()
      // `update-downloaded` nastaví stav ready. Instalátor se spouští až
      // explicitním druhým kliknutím, aby uživatel nepřišel o rozdělanou práci.
    } catch (error) {
      this.setState({ status: 'error', error: sanitizeUnknownError(error) })
    }
    return this.getState()
  }

  restartAndInstall(): AppUpdateState {
    this.initialize()
    if (this.state.status !== 'ready') return this.getState()
    this.setState({ status: 'installing', progressPercent: 100, error: null })
    setImmediate(() => this.updater.quitAndInstall(false, true))
    return this.getState()
  }

  private initialize(): void {
    if (this.initialized) return
    this.initialized = true
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = true

    this.updater.on('update-available', (info: UpdateInfo) => {
      this.setState({
        status: 'available',
        latestVersion: info.version,
        releaseName: typeof info.releaseName === 'string' ? info.releaseName : null,
        releaseUrl: `https://github.com/sedlacl/OllamaStudio/releases/tag/v${info.version}`,
        progressPercent: null,
        error: null
      })
    })
    this.updater.on('update-not-available', (info: UpdateInfo) => {
      this.setState({
        status: 'up-to-date',
        latestVersion: info.version,
        releaseName: typeof info.releaseName === 'string' ? info.releaseName : null,
        releaseUrl: null,
        progressPercent: null,
        error: null
      })
    })
    this.updater.on('download-progress', (progress: ProgressInfo) => {
      this.setState({
        status: 'downloading',
        progressPercent: Math.max(0, Math.min(100, progress.percent))
      })
    })
    this.updater.on('update-downloaded', (info: UpdateInfo) => {
      this.setState({
        status: 'ready',
        latestVersion: info.version,
        progressPercent: 100,
        error: null
      })
    })
    this.updater.on('error', (error: Error) => {
      this.setState({ status: 'error', error: sanitizeUnknownError(error) })
    })
  }

  private setState(patch: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...patch }
    const snapshot = this.getState()
    for (const listener of this.listeners) listener(snapshot)
  }
}

export const studioAppUpdater = new StudioAppUpdater()
