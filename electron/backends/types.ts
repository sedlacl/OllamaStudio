/** Společné typy pro Ollama a TabbyAPI backendy. */

export type BackendId = 'ollama' | 'tabby'

export type ProcessStatus =
  | 'external'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'failed'

export type EndpointStatus =
  | 'unreachable'
  | 'healthy'
  | 'unauthorized'
  | 'incompatible'
  | 'degraded'

export interface BackendCapabilities {
  pullLibraryTag: boolean
  cloneModel: boolean
  deleteModel: boolean
  keepAlive: boolean
  multiLoaded: boolean
  hfDownload: boolean
  mtp: boolean
  speedTestAutoAfterLoad: boolean
  continueIntegration: boolean
  opencodeIntegration: boolean
}

export interface ModelSummary {
  modelId: string
  displayName: string
  backend: BackendId
  sizeBytes?: number
  format?: string
  family?: string
  parameterSize?: string
  quantization?: string
  modifiedAt?: string
  digest?: string
}

export interface LoadedModelSummary {
  modelId: string
  displayName: string
  backend: BackendId
  sizeBytes?: number
  sizeVramBytes?: number
  contextLength?: number
  expiresAt?: string
  cacheMode?: string
  cacheSize?: number
  draftMode?: string
  draftModelId?: string
}

export interface BackendServeState {
  backend: BackendId
  processStatus: ProcessStatus
  endpointStatus: EndpointStatus
  /** Legacy ServeState.status mirror for UI that still expects ollama-shaped status. */
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  pid: number | null
  spawnTime: number | null
  binaryPath: string | null
  error: string | null
  portConflict: boolean
  ownedByStudio: boolean
  /** Studio převzalo osiřelý proces z předchozího běhu (ne čerstvý spawn). */
  adoptedExisting?: boolean
  auth: {
    hasApiKey: boolean
    hasAdminKey: boolean
    disableAuth: boolean
  }
}

export interface OperationProgress {
  operationId: string
  kind: 'download' | 'load' | 'unload' | 'speed-test'
  status: 'running' | 'success' | 'error'
  message?: string
  /** 0–100 when known; omit for indeterminate progress. */
  percent?: number
  modelId?: string
  error?: string
  startedAt: number
  updatedAt: number
}

export const OLLAMA_CAPABILITIES: BackendCapabilities = {
  pullLibraryTag: true,
  cloneModel: true,
  deleteModel: true,
  keepAlive: true,
  multiLoaded: true,
  hfDownload: false,
  mtp: false,
  speedTestAutoAfterLoad: true,
  continueIntegration: true,
  opencodeIntegration: true
}

export const TABBY_CAPABILITIES: BackendCapabilities = {
  pullLibraryTag: false,
  cloneModel: false,
  deleteModel: false,
  keepAlive: false,
  multiLoaded: false,
  hfDownload: true,
  mtp: true,
  speedTestAutoAfterLoad: false,
  continueIntegration: false,
  opencodeIntegration: true
}

export function capabilitiesFor(backend: BackendId): BackendCapabilities {
  return backend === 'tabby' ? TABBY_CAPABILITIES : OLLAMA_CAPABILITIES
}
