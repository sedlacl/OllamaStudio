import {
  isBackendId,
  modelRefKey,
  type ModelLoadResult,
  type ModelOperationRequest,
  type ModelProfile,
  type ModelRef
} from '../../shared/backend-contract'
import type { ModelSpeedTestResult } from '../ollama/client'
import { getActiveBackend } from '../ollama/config'
import { clearAllLoadOptions, removeLoadOptions } from '../ollama/load-options-registry'
import {
  clearModelLoadState,
  getActiveModelLoads
} from '../ollama/model-load-manager'
import {
  clearAllSpeedTests,
  removeSpeedTest
} from '../ollama/speed-test-registry'
import { switchActiveBackendForModel } from '../tabby/active-backend'
import { getProvider } from './registry'
import { modelProfileStore } from './model-profile-store'
import type { BackendProvider } from './provider'

interface ProfileStore {
  get(ref: ModelRef): ModelProfile
  save(ref: ModelRef, profile: unknown): ModelProfile
}

interface CoordinatorDependencies {
  getActiveProviderId: () => ModelRef['providerId']
  getProvider: (id: ModelRef['providerId']) => BackendProvider
  switchProvider: (id: ModelRef['providerId']) => Promise<unknown>
  profiles: ProfileStore
  clearRuntimeRegistries: () => void
  hasActiveLoad: () => boolean
}

const defaults: CoordinatorDependencies = {
  getActiveProviderId: getActiveBackend,
  getProvider,
  switchProvider: switchActiveBackendForModel,
  profiles: modelProfileStore,
  clearRuntimeRegistries: () => {
    clearAllLoadOptions()
    clearAllSpeedTests()
  },
  hasActiveLoad: () => getActiveModelLoads().some((state) => state.status === 'loading')
}

function validateRef(value: unknown): asserts value is ModelRef {
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

export class ModelCoordinator {
  private readonly inFlight = new Set<string>()

  constructor(private readonly dependencies: CoordinatorDependencies = defaults) {}

  async load(
    request: ModelOperationRequest,
    onLoaded?: (ref: ModelRef) => void
  ): Promise<ModelLoadResult> {
    validateRef(request?.ref)
    const ref = { ...request.ref, modelId: request.ref.modelId.trim() }
    const key = modelRefKey(ref)
    if (this.inFlight.has(key) || this.dependencies.hasActiveLoad()) {
      return { ok: false, error: 'MODEL_OPERATION_IN_PROGRESS' }
    }
    this.inFlight.add(key)
    try {
      const profile = this.dependencies.profiles.save(
        ref,
        request.profile ?? this.dependencies.profiles.get(ref)
      )
      const provider = await this.activate(ref)
      const decision = await provider.decideModelCompatibility(ref, profile)
      if (decision.action === 'restart-provider') {
        const state = provider.getServeState()
        if (provider.isRunning()) {
          if (!state.ownedByStudio) throw new Error('EXTERNAL_RUNTIME_RESTART_FORBIDDEN')
          this.dependencies.clearRuntimeRegistries()
          provider.clearRuntimeModelState()
          const restarted = await provider.restartForModel(profile)
          if (restarted.status !== 'running') throw new Error('PROVIDER_START_FAILED')
        } else {
          this.dependencies.clearRuntimeRegistries()
          provider.clearRuntimeModelState()
          const started = await provider.startForModel(profile)
          if (started.status !== 'running') throw new Error('PROVIDER_START_FAILED')
        }
      }
      if (decision.action === 'reuse') {
        onLoaded?.(ref)
        return { ok: true, action: 'reuse' }
      }
      const result = provider.loadModel(
        ref.modelId,
        profile,
        () => onLoaded?.(ref)
      )
      return { ...result, action: decision.action }
    } finally {
      this.inFlight.delete(key)
    }
  }

  async unload(ref: ModelRef): Promise<void> {
    validateRef(ref)
    const provider = this.dependencies.getProvider(ref.providerId)
    const state = provider.getServeState()
    if (state.endpointStatus === 'healthy') {
      await provider.unloadModel(ref.modelId)
    }
    removeLoadOptions(ref)
    removeSpeedTest(ref)
    clearModelLoadState(ref)
  }

  async test(ref: ModelRef): Promise<ModelSpeedTestResult> {
    validateRef(ref)
    const profile = this.dependencies.profiles.get(ref)
    const provider = await this.activate(ref)
    if (!provider.isRunning()) {
      const started = await provider.startForModel(profile)
      if (started.status !== 'running') throw new Error('PROVIDER_START_FAILED')
    }
    return provider.testSpeed(ref.modelId)
  }

  private async activate(ref: ModelRef): Promise<BackendProvider> {
    if (this.dependencies.getActiveProviderId() !== ref.providerId) {
      await this.dependencies.switchProvider(ref.providerId)
    }
    return this.dependencies.getProvider(ref.providerId)
  }
}

export const modelCoordinator = new ModelCoordinator()
