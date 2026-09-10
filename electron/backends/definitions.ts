import type {
  BackendDescriptor,
  BackendId,
  ModelProfile,
  OllamaModelProfile,
  TabbyModelProfile
} from '../../shared/backend-contract'
import { OLLAMA_CAPABILITIES, TABBY_CAPABILITIES } from './types'
import { loadConfig } from '../ollama/config'

export const BACKEND_DESCRIPTORS: Record<BackendId, BackendDescriptor> = {
  ollama: {
    id: 'ollama',
    displayNameKey: 'backend.ollama',
    capabilities: OLLAMA_CAPABILITIES,
    acquisition: 'ollama-library',
    settings: {
      fields: [
        { id: 'env.OLLAMA_HOST', type: 'string', labelKey: 'OLLAMA_HOST', restartRequired: true },
        { id: 'env.OLLAMA_MODELS', type: 'path', labelKey: 'OLLAMA_MODELS', restartRequired: true },
        { id: 'autoStartServe', type: 'boolean', labelKey: 'server.autoStart', restartRequired: false }
      ]
    }
  },
  tabby: {
    id: 'tabby',
    displayNameKey: 'backend.tabby',
    capabilities: TABBY_CAPABILITIES,
    acquisition: 'hugging-face',
    settings: {
      fields: [
        { id: 'installDir', type: 'path', labelKey: 'server.tabbyInstallDir', restartRequired: true },
        { id: 'pythonPath', type: 'path', labelKey: 'server.tabbyPythonPath', restartRequired: true },
        { id: 'configPath', type: 'path', labelKey: 'server.tabbyConfigPath', restartRequired: true },
        { id: 'host', type: 'string', labelKey: 'server.tabbyHost', restartRequired: true },
        { id: 'port', type: 'number', labelKey: 'server.tabbyPort', restartRequired: true, min: 1, max: 65535 },
        { id: 'modelDir', type: 'path', labelKey: 'server.tabbyModelDir', restartRequired: true },
        { id: 'autoStartServe', type: 'boolean', labelKey: 'server.tabbyAutoStart', restartRequired: false }
      ]
    }
  }
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined
}

function finiteAtLeast(value: unknown, minimum: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum
    ? value
    : undefined
}

export function normalizeModelProfile<I extends BackendId>(
  providerId: I,
  value: unknown
): ModelProfile<I> {
  const obj = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (providerId === 'ollama') {
    const defaults = loadConfig().providers.ollama.profileDefaults
    const profile: OllamaModelProfile = {
      keepAlive: typeof obj.keepAlive === 'string' && obj.keepAlive.trim()
        ? obj.keepAlive.trim()
        : defaults.keepAlive,
      numCtx: finitePositive(obj.numCtx) ?? defaults.numCtx
    }
    for (const key of ['numBatch', 'ropeFrequencyBase', 'ropeFrequencyScale'] as const) {
      const normalized = finitePositive(obj[key])
      if (normalized != null) profile[key] = normalized
    }
    const numGpu = finiteAtLeast(obj.numGpu, -1)
    if (numGpu != null) profile.numGpu = numGpu
    const numThread = finiteAtLeast(obj.numThread, 0)
    if (numThread != null) profile.numThread = numThread
    for (const key of ['useMmap', 'useMlock'] as const) {
      if (typeof obj[key] === 'boolean') profile[key] = obj[key]
    }
    return profile as ModelProfile<I>
  }

  const profile: TabbyModelProfile = {
    maxSeqLen: 8192,
    cacheSize: 8192,
    cacheMode: 'FP16',
    tensorParallel: true,
    gpuSplitAuto: true,
    outputChunking: false,
    vision: false,
    mtp: { enabled: false, draftNumTokens: 4 }
  }
  for (const key of ['maxSeqLen', 'cacheSize', 'chunkSize'] as const) {
    const normalized = finitePositive(obj[key])
    if (normalized != null) profile[key] = normalized
  }
  for (const key of ['cacheMode', 'promptTemplate'] as const) {
    if (typeof obj[key] === 'string') profile[key] = obj[key]
  }
  for (const key of ['tensorParallel', 'gpuSplitAuto', 'outputChunking', 'vision'] as const) {
    if (typeof obj[key] === 'boolean') profile[key] = obj[key]
  }
  for (const key of ['gpuSplit', 'autosplitReserve'] as const) {
    if (Array.isArray(obj[key]) && obj[key].every((part) => typeof part === 'number' && Number.isFinite(part) && part >= 0)) {
      profile[key] = [...obj[key]]
    }
  }
  const ropeScale = finitePositive(obj.ropeScale)
  if (ropeScale != null) profile.ropeScale = ropeScale
  if (obj.ropeAlpha === 'auto') profile.ropeAlpha = 'auto'
  else {
    const ropeAlpha = finitePositive(obj.ropeAlpha)
    if (ropeAlpha != null) profile.ropeAlpha = ropeAlpha
  }
  if (obj.mtp && typeof obj.mtp === 'object') {
    const mtp = obj.mtp as Record<string, unknown>
    profile.mtp = {
      enabled: mtp.enabled === true,
      ...(finitePositive(mtp.draftNumTokens) != null ? { draftNumTokens: finitePositive(mtp.draftNumTokens) } : {}),
      ...(typeof mtp.dynamicDraft === 'boolean' ? { dynamicDraft: mtp.dynamicDraft } : {})
    }
  }
  if (obj.draftModel && typeof obj.draftModel === 'object') {
    const draft = obj.draftModel as Record<string, unknown>
    profile.draftModel = {}
    if (typeof draft.draftModelName === 'string') profile.draftModel.draftModelName = draft.draftModelName
    const draftRopeScale = finitePositive(draft.draftRopeScale)
    if (draftRopeScale != null) profile.draftModel.draftRopeScale = draftRopeScale
    if (draft.draftRopeAlpha === 'auto') profile.draftModel.draftRopeAlpha = 'auto'
    else {
      const draftRopeAlpha = finitePositive(draft.draftRopeAlpha)
      if (draftRopeAlpha != null) profile.draftModel.draftRopeAlpha = draftRopeAlpha
    }
    if (
      Array.isArray(draft.draftGpuSplit) &&
      draft.draftGpuSplit.every((part) => typeof part === 'number' && Number.isFinite(part) && part >= 0)
    ) {
      profile.draftModel.draftGpuSplit = [...draft.draftGpuSplit]
    }
  }
  return profile as ModelProfile<I>
}

export function profileFingerprint(providerId: BackendId, value: unknown): string {
  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable)
    if (!input || typeof input !== 'object') return input
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stable(nested)])
    )
  }
  return JSON.stringify(stable(normalizeModelProfile(providerId, value)))
}
