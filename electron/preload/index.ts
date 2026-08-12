import { contextBridge, ipcRenderer } from 'electron'

export interface Api {
  getServeStatus: () => Promise<unknown>
  getDashboard: () => Promise<unknown>
  getResourceUsage: () => Promise<unknown>
  getModelsTags: () => Promise<unknown>
  getModelsPs: () => Promise<unknown>
  modelShow: (name: string) => Promise<unknown>
  modelLoad: (name: string, options?: unknown) => Promise<{ ok: boolean; error?: string }>
  modelUnload: (name: string) => Promise<void>
  modelDelete: (name: string) => Promise<void>
  modelCopy: (source: string, destination: string) => Promise<void>
  modelPull: (name: string) => Promise<{ ok: boolean; error?: string }>
  getModelLoadOptions: (name: string) => Promise<unknown>
  getModelLoadStatus: () => Promise<unknown>
  onModelLoadStatus: (cb: (state: unknown) => void) => () => void
  onPullProgress: (cb: (data: unknown) => void) => () => void
  getServerConfig: () => Promise<unknown>
  saveServerConfigAndRestart: (config: unknown) => Promise<unknown>
  startServer: (forceKillConflict?: boolean) => Promise<unknown>
  stopServer: () => Promise<unknown>
  restartServer: (forceKillConflict?: boolean) => Promise<unknown>
  getLogs: (limit?: number) => Promise<unknown>
  clearLogs: () => Promise<boolean>
  subscribeLogs: (cb: (entry: unknown) => void) => () => void
  subscribeDashboardRequests: (cb: () => void) => () => void
  detectOllamaBinary: () => Promise<string | null>
}

const api: Api = {
  getServeStatus: () => ipcRenderer.invoke('get-serve-status'),
  getDashboard: () => ipcRenderer.invoke('get-dashboard'),
  getResourceUsage: () => ipcRenderer.invoke('get-resource-usage'),
  getModelsTags: () => ipcRenderer.invoke('get-models-tags'),
  getModelsPs: () => ipcRenderer.invoke('get-models-ps'),
  modelShow: (name) => ipcRenderer.invoke('model-show', name),
  modelLoad: (name, options) => ipcRenderer.invoke('model-load', name, options),
  modelUnload: (name) => ipcRenderer.invoke('model-unload', name),
  modelDelete: (name) => ipcRenderer.invoke('model-delete', name),
  modelCopy: (source, destination) => ipcRenderer.invoke('model-copy', source, destination),
  modelPull: (name) => ipcRenderer.invoke('model-pull', name),
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
  startServer: (force) => ipcRenderer.invoke('start-server', force),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  restartServer: (force) => ipcRenderer.invoke('restart-server', force),
  getLogs: (limit) => ipcRenderer.invoke('get-logs', limit),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
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
  detectOllamaBinary: () => ipcRenderer.invoke('detect-ollama-binary')
}

contextBridge.exposeInMainWorld('ollamaStudio', api)
