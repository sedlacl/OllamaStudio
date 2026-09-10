import { app } from 'electron'
import type {
  BackendId,
  ModelAcquisitionRequest,
  ModelOperationRequest,
  ModelProfile,
  ModelRef
} from '../../shared/backend-contract'
import { isBackendId, modelRefKey } from '../../shared/backend-contract'
import { modelAcquisitionManager } from '../backends/model-acquisition-manager'
import { modelCatalog } from '../backends/model-catalog'
import { modelCoordinator } from '../backends/model-coordinator'
import { modelProfileStore } from '../backends/model-profile-store'
import { getActiveProvider, getProvider } from '../backends/registry'
import { tMain } from '../i18n'
import {
  getActiveBackend,
  saveBackendSettings
} from '../ollama/config'
import {
  removeContinueModel,
  upsertContinueModel
} from '../ollama/continue-config'
import { getIntegrationsStatus } from '../ollama/integrations-status'
import { getLoadOptions, removeLoadOptions } from '../ollama/load-options-registry'
import { logBuffer, type LogCategory, type LogLevel } from '../ollama/log-buffer'
import { collectResourceUsage } from '../ollama/metrics'
import {
  deletePreset,
  listPresets,
  savePreset,
  type PresetKind
} from '../ollama/presets'
import {
  getSpeedTest,
  recordSpeedTest,
  removeSpeedTest
} from '../ollama/speed-test-registry'
import {
  removeOpenCodeModel,
  upsertOpenCodeModel
} from '../ollama/opencode-config'
import { sanitizeSpeedTestResult, sanitizeUnknownError } from '../security/sanitize-state'
import {
  getActiveCapabilities,
  getUnifiedServeState,
  restartActiveBackend,
  startActiveBackend,
  stopActiveBackend,
  switchActiveBackend
} from '../tabby/active-backend'
import {
  runTestQuery as executeTestQuery,
  TestQueryError
} from './test-query'

const speedTestsInFlight = new Set<string>()

function assertModelRef(value: unknown): asserts value is ModelRef {
  const ref = value as Partial<ModelRef> | null
  if (
    !ref ||
    !isBackendId(ref.providerId) ||
    typeof ref.modelId !== 'string' ||
    !ref.modelId.trim() ||
    ref.modelId.includes('\0')
  ) {
    throw new Error('INVALID_MODEL_REFERENCE')
  }
}

function cleanRef(ref: ModelRef): ModelRef {
  assertModelRef(ref)
  return { providerId: ref.providerId, modelId: ref.modelId.trim() }
}

/** Shared by IPC and MCP so concurrent tests use one lock and one result registry. */
export async function runModelSpeedTest(ref: ModelRef) {
  const normalized = cleanRef(ref)
  const key = modelRefKey(normalized)
  if (speedTestsInFlight.has(key)) {
    throw new Error(tMain('errors.speedTestRunning', { name: normalized.modelId }))
  }
  speedTestsInFlight.add(key)
  try {
    const result = sanitizeSpeedTestResult(await modelCoordinator.test(normalized))
    recordSpeedTest(normalized, result)
    return result
  } finally {
    speedTestsInFlight.delete(key)
  }
}

/** Shared cleanup after deletion keeps profile-adjacent runtime state consistent. */
export async function deleteStudioModel(ref: ModelRef): Promise<{ ok: true }> {
  const normalized = cleanRef(ref)
  const provider = getProvider(normalized.providerId)
  if (!provider.capabilities.deleteModel) throw new Error('MODEL_DELETE_UNSUPPORTED')
  await provider.deleteModel(normalized.modelId)
  removeLoadOptions(normalized)
  removeSpeedTest(normalized)
  modelCatalog.invalidate()
  return { ok: true }
}

function speedTestFor(ref: ModelRef): unknown {
  return getSpeedTest(ref)
}

function limitLogText(text: string): string {
  const max = 4_000
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`
}

export interface GetLogsInput {
  limit?: number
  text?: string
  level?: LogLevel
  category?: LogCategory
}

export const studioMcpHandlers = {
  studioStatus() {
    return {
      version: app.getVersion(),
      activeBackend: getActiveBackend(),
      serve: getUnifiedServeState(),
      capabilities: getActiveCapabilities()
    }
  },

  getLogs(input: GetLogsInput) {
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 200)))
    const needle = input.text?.trim().toLocaleLowerCase('en-US')
    const matching = logBuffer.getEntries(5_000).filter((entry) => {
      if (input.level && entry.level !== input.level) return false
      if (input.category && entry.category !== input.category) return false
      return !needle || entry.text.toLocaleLowerCase('en-US').includes(needle)
    })
    const entries = []
    let outputChars = 0
    for (let index = matching.length - 1; index >= 0 && entries.length < limit; index -= 1) {
      const entry = matching[index]
      const text = limitLogText(entry.text)
      if (entries.length > 0 && outputChars + text.length > 200_000) break
      outputChars += text.length
      entries.unshift({ ...entry, text })
    }
    return {
      entries,
      returned: entries.length,
      matching: matching.length,
      truncated: matching.length > entries.length
    }
  },

  async getResources() {
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
      backendId: provider.id,
      activeRequests: logBuffer.getActiveRequests(),
      requestHistory: logBuffer.getRequestHistory()
    }
  },

  listModels() {
    return modelCatalog.refresh()
  },

  async getModel(ref: ModelRef) {
    const normalized = cleanRef(ref)
    const provider = getProvider(normalized.providerId)
    const [metadata, details] = await Promise.all([
      provider.getModelMetadata(normalized),
      provider.showModel(normalized.modelId)
    ])
    return {
      ref: normalized,
      metadata,
      details,
      profile: modelProfileStore.getStored(normalized) ?? {
        profile: modelProfileStore.get(normalized),
        updatedAt: null,
        fingerprint: null
      },
      lastLoadOptions: getLoadOptions(normalized),
      lastSpeedTest: speedTestFor(normalized)
    }
  },

  getAcquisitions() {
    return modelAcquisitionManager.getAll()
  },

  integrationsStatus(refs: ModelRef[]) {
    return getIntegrationsStatus(refs.map(cleanRef))
  },

  getModelProfile(ref: ModelRef) {
    const normalized = cleanRef(ref)
    return {
      ref: normalized,
      stored: modelProfileStore.getStored(normalized),
      effective: modelProfileStore.get(normalized)
    }
  },

  saveModelProfile(ref: ModelRef, profile: unknown) {
    const normalized = cleanRef(ref)
    return {
      ref: normalized,
      profile: modelProfileStore.save(normalized, profile)
    }
  },

  loadModel(request: ModelOperationRequest) {
    return modelCoordinator.load({
      ref: cleanRef(request.ref),
      profile: request.profile
    })
  },

  async unloadModel(ref: ModelRef) {
    const normalized = cleanRef(ref)
    await modelCoordinator.unload(normalized)
    return { ok: true, ref: normalized }
  },

  runSpeedTest(ref: ModelRef) {
    return runModelSpeedTest(ref)
  },

  runTestQuery(input: unknown) {
    return executeTestQuery(input)
  },

  acquireModel(request: ModelAcquisitionRequest) {
    return modelAcquisitionManager.start(request)
  },

  startServer(forceKillConflict = false) {
    return startActiveBackend(forceKillConflict)
  },

  stopServer() {
    return stopActiveBackend()
  },

  restartServer(forceKillConflict = false) {
    return restartActiveBackend(forceKillConflict)
  },

  switchBackend(providerId: BackendId) {
    if (!isBackendId(providerId)) throw new Error('INVALID_BACKEND')
    return switchActiveBackend(providerId)
  },

  saveBackendSettings(providerId: BackendId, patch: unknown) {
    if (!isBackendId(providerId) || !patch || typeof patch !== 'object') {
      throw new Error('INVALID_BACKEND_SETTINGS')
    }
    return {
      providerId,
      settings: saveBackendSettings(providerId, patch as never)
    }
  },

  deleteModel(ref: ModelRef) {
    return deleteStudioModel(ref)
  },

  async copyModel(
    providerId: BackendId,
    source: string,
    destination: string,
    stripVision = false
  ) {
    if (!isBackendId(providerId)) throw new Error('INVALID_BACKEND')
    const provider = getProvider(providerId)
    if (!provider.capabilities.cloneModel) throw new Error('MODEL_COPY_UNSUPPORTED')
    await provider.cloneModel(source.trim(), destination.trim(), { stripVision })
    modelCatalog.invalidate()
    return {
      ok: true,
      providerId,
      source: source.trim(),
      destination: destination.trim(),
      stripVision
    }
  },

  async killProcess(providerId: BackendId, pid: number) {
    if (!isBackendId(providerId)) throw new Error('INVALID_BACKEND')
    return getProvider(providerId).killProcess(pid)
  },

  upsertContinue(ref: ModelRef) {
    const normalized = cleanRef(ref)
    if (normalized.providerId !== 'ollama') throw new Error('CONTINUE_UNSUPPORTED_PROVIDER')
    const ollamaRef: ModelRef & { providerId: 'ollama' } = {
      providerId: 'ollama',
      modelId: normalized.modelId
    }
    return upsertContinueModel(ollamaRef, modelProfileStore.get(ollamaRef))
  },

  removeContinue(ref: ModelRef) {
    return { removed: removeContinueModel(cleanRef(ref)) }
  },

  upsertOpenCode(ref: ModelRef) {
    const normalized = cleanRef(ref)
    return upsertOpenCodeModel(normalized, modelProfileStore.get(normalized))
  },

  removeOpenCode(ref: ModelRef) {
    return { removed: removeOpenCodeModel(cleanRef(ref)) }
  },

  listPresets(kind: PresetKind) {
    return listPresets(kind)
  },

  savePreset(kind: PresetKind, name: string, data: unknown, id?: string) {
    return savePreset(kind, name, data as never, id)
  },

  deletePreset(kind: PresetKind, id: string) {
    return { deleted: deletePreset(kind, id) }
  }
}

export type StudioMcpHandlers = typeof studioMcpHandlers

export function formatMcpHandlerError(error: unknown): string {
  if (error instanceof TestQueryError) {
    return `${error.code}: ${sanitizeUnknownError(error)}`
  }
  return sanitizeUnknownError(error)
}
