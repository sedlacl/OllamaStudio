import { contextBridge, ipcRenderer } from 'electron'

export interface TabbyDownloadRequest {
  repoId: string
  revision?: string
  folderName?: string
  token?: string
}

export interface TabbyDownloadProgress {
  operationId: string
  status: 'running' | 'success' | 'error'
  message?: string
  percent?: number | null
  bytesDownloaded?: number
  bytesTotal?: number | null
}

export type TabbyDownloadSessionStatus =
  | 'running'
  | 'success'
  | 'error'
  | 'interrupted'
  | 'conflict'

export interface TabbyDownloadFormSnapshot {
  repoId: string
  revision: string
  folderName: string
}

export interface TabbyDownloadSessionView {
  sequence: number
  operationId: string
  status: TabbyDownloadSessionStatus
  repoId: string
  revision: string
  folderName: string
  startedAt: number
  updatedAt: number
  downloadedBytes: number
  totalBytes: number | null
  percent: number | null
  error?: string
  folderConflict?: TabbyDownloadFolderConflict
  dismissed: boolean
  bytesPerSec?: number | null
  etaSeconds?: number | null
}

export interface TabbyDownloadStatusSnapshot {
  sequence: number
  session: TabbyDownloadSessionView | null
  form: TabbyDownloadFormSnapshot
}

export interface HfRefsRequest {
  repoId: string
  token?: string
}

export interface HfRevision {
  name: string
  type: 'branch' | 'tag'
}

export interface HfRefsResult {
  ok: boolean
  revisions?: HfRevision[]
  error?: string
}

export type FolderCompleteness = 'complete' | 'partial' | 'unknown'

export interface TabbyDownloadFolderConflict {
  folderName: string
  bytesOnDisk: number
  expectedBytes: number | null
  completeness: FolderCompleteness
  suggestedFolderName: string
}

export interface TabbyDownloadResult {
  ok: boolean
  downloadPath?: string
  error?: string
  folderConflict?: TabbyDownloadFolderConflict
  alreadyRunning?: boolean
}

export interface Api {
  getServeStatus: () => Promise<unknown>
  getAppVersion: () => Promise<string>
  getDashboard: () => Promise<unknown>
  getResourceUsage: () => Promise<unknown>
  getModelsTags: () => Promise<unknown>
  getModelsPs: () => Promise<unknown>
  modelShow: (name: string) => Promise<unknown>
  modelLoad: (name: string, options?: unknown) => Promise<{ ok: boolean; error?: string }>
  modelUnload: (name: string) => Promise<void>
  modelTestSpeed: (name: string) => Promise<unknown>
  getSpeedTests: () => Promise<unknown>
  onSpeedTestsChanged: (cb: () => void) => () => void
  checkOllamaUpdate: (force?: boolean) => Promise<unknown>
  openExternal: (url: string) => Promise<void>
  modelDelete: (name: string) => Promise<void>
  modelCopy: (source: string, destination: string) => Promise<void>
  modelPull: (name: string) => Promise<{ ok: boolean; error?: string }>
  tabbyDownload: (req: TabbyDownloadRequest) => Promise<TabbyDownloadResult>
  tabbyDeleteDownloadFolder: (folderName: string) => Promise<{ ok: boolean; error?: string }>
  tabbyHfRefs: (req: HfRefsRequest) => Promise<HfRefsResult>
  onTabbyDownloadProgress: (cb: (data: TabbyDownloadProgress) => void) => () => void
  getTabbyDownloadStatus: () => Promise<TabbyDownloadStatusSnapshot>
  dismissTabbyDownload: () => Promise<TabbyDownloadStatusSnapshot>
  rememberTabbyDownloadForm: (form: TabbyDownloadFormSnapshot) => Promise<TabbyDownloadStatusSnapshot>
  onTabbyDownloadStatus: (cb: (data: TabbyDownloadStatusSnapshot) => void) => () => void
  getModelLoadOptions: (name: string) => Promise<unknown>
  getModelLoadStatus: () => Promise<unknown>
  onModelLoadStatus: (cb: (state: unknown) => void) => () => void
  onPullProgress: (cb: (data: unknown) => void) => () => void
  getServerConfig: () => Promise<unknown>
  saveServerConfigAndRestart: (config: unknown) => Promise<unknown>
  switchBackend: (backend: 'ollama' | 'tabby') => Promise<unknown>
  getBackendCapabilities: () => Promise<unknown>
  tabbyPreflight: () => Promise<unknown>
  startServer: (forceKillConflict?: boolean) => Promise<unknown>
  stopServer: () => Promise<unknown>
  restartServer: (forceKillConflict?: boolean) => Promise<unknown>
  getLogs: (limit?: number) => Promise<unknown>
  clearLogs: (options?: { disk?: boolean }) => Promise<boolean>
  scrubTabbyRuntimeLogs: () => Promise<{
    scrubbed: Array<{ ok: boolean; path: string; linesRead: number; linesChanged: number; error?: string }>
    zipFiles: string[]
    skippedZip: boolean
  }>
  deleteTabbyRuntimeZipLogs: (zipPaths: string[]) => Promise<{ deleted: string[]; errors: string[] }>
  subscribeLogs: (cb: (entry: unknown) => void) => () => void
  subscribeDashboardRequests: (cb: () => void) => () => void
  detectOllamaBinary: () => Promise<string | null>
  listPresets: (kind: string) => Promise<unknown>
  savePreset: (kind: string, name: string, data: unknown, id?: string) => Promise<unknown>
  deletePreset: (kind: string, id: string) => Promise<boolean>
  importPreset: (kind: string, json: string) => Promise<unknown>
  getContinueStatus: () => Promise<unknown>
  upsertContinueModel: (modelName: string) => Promise<unknown>
  removeContinueModel: (modelName: string) => Promise<boolean>
  getIntegrationsStatus: (modelNames: string[]) => Promise<unknown>
  upsertOpenCodeModel: (modelName: string) => Promise<unknown>
  removeOpenCodeModel: (modelName: string) => Promise<boolean>
  killOllamaProcess: (pid: number) => Promise<{ ok: boolean; error?: string }>
  getAppLanguage: () => Promise<'cs' | 'en'>
  setAppLanguage: (language: 'cs' | 'en') => Promise<'cs' | 'en'>
}

const api: Api = {
  getServeStatus: () => ipcRenderer.invoke('get-serve-status'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getDashboard: () => ipcRenderer.invoke('get-dashboard'),
  getResourceUsage: () => ipcRenderer.invoke('get-resource-usage'),
  getModelsTags: () => ipcRenderer.invoke('get-models-tags'),
  getModelsPs: () => ipcRenderer.invoke('get-models-ps'),
  modelShow: (name) => ipcRenderer.invoke('model-show', name),
  modelLoad: (name, options) => ipcRenderer.invoke('model-load', name, options),
  modelUnload: (name) => ipcRenderer.invoke('model-unload', name),
  modelTestSpeed: (name) => ipcRenderer.invoke('model-test-speed', name),
  getSpeedTests: () => ipcRenderer.invoke('get-speed-tests'),
  onSpeedTestsChanged: (cb) => {
    const handler = (): void => cb()
    ipcRenderer.on('speed-tests-changed', handler)
    return () => ipcRenderer.removeListener('speed-tests-changed', handler)
  },
  checkOllamaUpdate: (force) => ipcRenderer.invoke('check-ollama-update', force),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  modelDelete: (name) => ipcRenderer.invoke('model-delete', name),
  modelCopy: (source, destination) => ipcRenderer.invoke('model-copy', source, destination),
  modelPull: (name) => ipcRenderer.invoke('model-pull', name),
  tabbyDownload: (req) => ipcRenderer.invoke('tabby-download', req),
  tabbyDeleteDownloadFolder: (folderName) =>
    ipcRenderer.invoke('tabby-delete-download-folder', folderName),
  tabbyHfRefs: (req) => ipcRenderer.invoke('tabby-hf-refs', req),
  onTabbyDownloadProgress: (cb) => {
    const handler = (_: unknown, data: TabbyDownloadProgress) => cb(data)
    ipcRenderer.on('tabby-download-progress', handler)
    return () => ipcRenderer.removeListener('tabby-download-progress', handler)
  },
  getTabbyDownloadStatus: () => ipcRenderer.invoke('tabby-download-status'),
  dismissTabbyDownload: () => ipcRenderer.invoke('tabby-download-dismiss'),
  rememberTabbyDownloadForm: (form) => ipcRenderer.invoke('tabby-download-remember-form', form),
  onTabbyDownloadStatus: (cb) => {
    const handler = (_: unknown, data: TabbyDownloadStatusSnapshot) => cb(data)
    ipcRenderer.on('tabby-download-status', handler)
    return () => ipcRenderer.removeListener('tabby-download-status', handler)
  },
  getModelLoadOptions: (name) => ipcRenderer.invoke('get-model-load-options', name),
  getModelLoadStatus: () => ipcRenderer.invoke('get-model-load-status'),
  onModelLoadStatus: (cb) => {
    const handler = (_: unknown, state: unknown) => cb(state)
    ipcRenderer.on('model-load-status', handler)
    return () => ipcRenderer.removeListener('model-load-status', handler)
  },
  onPullProgress: (cb) => {
    const handler = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('pull-progress', handler)
    return () => ipcRenderer.removeListener('pull-progress', handler)
  },
  getServerConfig: () => ipcRenderer.invoke('get-server-config'),
  saveServerConfigAndRestart: (config) => ipcRenderer.invoke('save-server-config-and-restart', config),
  switchBackend: (backend) => ipcRenderer.invoke('switch-backend', backend),
  getBackendCapabilities: () => ipcRenderer.invoke('get-backend-capabilities'),
  tabbyPreflight: () => ipcRenderer.invoke('tabby-preflight'),
  startServer: (force) => ipcRenderer.invoke('start-server', force),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  restartServer: (force) => ipcRenderer.invoke('restart-server', force),
  getLogs: (limit) => ipcRenderer.invoke('get-logs', limit),
  clearLogs: (options?: { disk?: boolean }) => ipcRenderer.invoke('clear-logs', options),
  scrubTabbyRuntimeLogs: () => ipcRenderer.invoke('scrub-tabby-runtime-logs'),
  deleteTabbyRuntimeZipLogs: (zipPaths: string[]) =>
    ipcRenderer.invoke('delete-tabby-runtime-zip-logs', zipPaths),
  subscribeLogs: (cb) => {
    const handler = (_: unknown, entry: unknown) => cb(entry)
    ipcRenderer.on('log-entry', handler)
    return () => ipcRenderer.removeListener('log-entry', handler)
  },
  subscribeDashboardRequests: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('dashboard-requests-changed', handler)
    return () => ipcRenderer.removeListener('dashboard-requests-changed', handler)
  },
  detectOllamaBinary: () => ipcRenderer.invoke('detect-ollama-binary'),
  listPresets: (kind) => ipcRenderer.invoke('presets-list', kind),
  savePreset: (kind, name, data, id) => ipcRenderer.invoke('presets-save', kind, name, data, id),
  deletePreset: (kind, id) => ipcRenderer.invoke('presets-delete', kind, id),
  importPreset: (kind, json) => ipcRenderer.invoke('presets-import', kind, json),
  getContinueStatus: () => ipcRenderer.invoke('continue-status'),
  upsertContinueModel: (modelName) => ipcRenderer.invoke('continue-upsert-model', modelName),
  removeContinueModel: (modelName) => ipcRenderer.invoke('continue-remove-model', modelName),
  getIntegrationsStatus: (modelNames) => ipcRenderer.invoke('integrations-status', modelNames),
  upsertOpenCodeModel: (modelName) => ipcRenderer.invoke('opencode-upsert-model', modelName),
  removeOpenCodeModel: (modelName) => ipcRenderer.invoke('opencode-remove-model', modelName),
  killOllamaProcess: (pid) => ipcRenderer.invoke('kill-ollama-process', pid),
  getAppLanguage: () => ipcRenderer.invoke('get-app-language'),
  setAppLanguage: (language) => ipcRenderer.invoke('set-app-language', language)
}

contextBridge.exposeInMainWorld('ollamaStudio', api)
