import { contextBridge, ipcRenderer } from 'electron'
import type { StudioApi } from '../../shared/studio-api'
import type {
  AcquisitionState,
  LogEntry,
  ModelLoadState,
  PullProgress,
  TabbyDownloadProgress,
  TabbyDownloadStatusSnapshot
} from '../../src/types/api'

const api = {
  getBackendDescriptors: () => ipcRenderer.invoke('get-backend-descriptors'),
  getBackendSettings: (id) => ipcRenderer.invoke('get-backend-settings', id),
  saveBackendSettings: (id, patch) => ipcRenderer.invoke('save-backend-settings', id, patch),
  getModelProfile: (ref) => ipcRenderer.invoke('get-model-profile', ref),
  saveModelProfile: (ref, profile) => ipcRenderer.invoke('save-model-profile', ref, profile),
  getServeStatus: () => ipcRenderer.invoke('get-serve-status'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getDashboard: () => ipcRenderer.invoke('get-dashboard'),
  getResourceUsage: () => ipcRenderer.invoke('get-resource-usage'),
  getModelCatalog: () => ipcRenderer.invoke('get-model-catalog'),
  startModelAcquisition: (request) =>
    ipcRenderer.invoke('start-model-acquisition', request),
  getModelAcquisitions: () => ipcRenderer.invoke('get-model-acquisitions'),
  dismissModelAcquisition: (operationId) =>
    ipcRenderer.invoke('dismiss-model-acquisition', operationId),
  onModelAcquisitionChanged: (cb) => {
    const handler = (_: unknown, state: AcquisitionState): void => cb(state)
    ipcRenderer.on('model-acquisition-changed', handler)
    return () => ipcRenderer.removeListener('model-acquisition-changed', handler)
  },
  invokeProviderAction: (request) =>
    ipcRenderer.invoke('invoke-provider-action', request),
  getModelsTags: () => ipcRenderer.invoke('get-models-tags'),
  getModelsPs: () => ipcRenderer.invoke('get-models-ps'),
  modelShow: (name) => ipcRenderer.invoke('model-show', name),
  modelLoad: (request) => ipcRenderer.invoke('model-load', request),
  modelUnload: (ref) => ipcRenderer.invoke('model-unload', ref),
  modelTestSpeed: (ref) => ipcRenderer.invoke('model-test-speed', ref),
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
  getModelLoadOptions: (ref) => ipcRenderer.invoke('get-model-load-options', ref),
  getModelLoadStatus: () => ipcRenderer.invoke('get-model-load-status'),
  onModelLoadStatus: (cb) => {
    const handler = (_: unknown, state: ModelLoadState) => cb(state)
    ipcRenderer.on('model-load-status', handler)
    return () => ipcRenderer.removeListener('model-load-status', handler)
  },
  onPullProgress: (cb) => {
    const handler = (_: unknown, data: { name: string; progress: PullProgress }) => cb(data)
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
    const handler = (_: unknown, entry: LogEntry) => cb(entry)
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
} satisfies StudioApi

contextBridge.exposeInMainWorld('ollamaStudio', api)
