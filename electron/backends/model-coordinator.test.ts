import { rmSync } from 'fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type {
  ModelCompatibilityDecision,
  ModelProfile
} from '../../shared/backend-contract'
import type { BackendProvider } from './provider'

const { userDataPath } = vi.hoisted(() => ({
  userDataPath: `${process.env.TEMP ?? process.cwd()}\\ollamastudio-coordinator-${process.pid}`
}))

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath }
}))

import { ModelCoordinator } from './model-coordinator'

afterAll(() => rmSync(userDataPath, { recursive: true, force: true }))

const ollamaProfile = { keepAlive: '30m', numCtx: 8192 }

function fakeProvider(options: {
  id?: 'ollama' | 'tabby'
  running?: boolean
  owned?: boolean
  decision: ModelCompatibilityDecision
}) {
  const id = options.id ?? 'ollama'
  let running = options.running ?? false
  const loadModel = vi.fn(() => ({ ok: true }))
  const startForModel = vi.fn(async () => {
    running = true
    return state()
  })
  const restartForModel = vi.fn(async () => {
    running = true
    return state()
  })
  const state = () => ({
    backend: id,
    processStatus: running ? ('running' as const) : ('stopped' as const),
    endpointStatus: running ? ('healthy' as const) : ('unreachable' as const),
    status: running ? ('running' as const) : ('stopped' as const),
    pid: running ? 42 : null,
    spawnTime: running ? 1 : null,
    binaryPath: null,
    error: null,
    portConflict: false,
    ownedByStudio: options.owned ?? true,
    auth: { hasApiKey: true, hasAdminKey: true, disableAuth: true }
  })
  const provider = {
    id,
    isRunning: () => running,
    getServeState: state,
    decideModelCompatibility: vi.fn(async () => options.decision),
    startForModel,
    restartForModel,
    clearRuntimeModelState: vi.fn(),
    loadModel,
    testSpeed: vi.fn()
  } as unknown as BackendProvider
  return { provider, loadModel, startForModel, restartForModel }
}

function coordinator(
  provider: BackendProvider,
  active: 'ollama' | 'tabby' = provider.id
) {
  let activeId = active
  const switchProvider = vi.fn(async (id: 'ollama' | 'tabby') => {
    activeId = id
  })
  const clearRuntimeRegistries = vi.fn()
  const profiles = {
    get: vi.fn(() => ollamaProfile as ModelProfile),
    save: vi.fn((_ref, profile) => profile as ModelProfile)
  }
  return {
    value: new ModelCoordinator({
      getActiveProviderId: () => activeId,
      getProvider: () => provider,
      switchProvider,
      profiles,
      clearRuntimeRegistries,
      hasActiveLoad: () => false
    }),
    switchProvider,
    clearRuntimeRegistries,
    profiles
  }
}

describe('model coordinator', () => {
  it('switches provider, starts it with the resolved profile, then loads', async () => {
    const fake = fakeProvider({
      id: 'tabby',
      running: false,
      decision: {
        action: 'restart-provider',
        fingerprint: 'fp',
        reason: 'provider-stopped'
      }
    })
    const setup = coordinator(fake.provider, 'ollama')

    await expect(
      setup.value.load({
        ref: { providerId: 'tabby', modelId: 'model' },
        profile: { maxSeqLen: 4096 }
      })
    ).resolves.toEqual({ ok: true, action: 'restart-provider' })
    expect(setup.switchProvider).toHaveBeenCalledWith('tabby')
    expect(fake.startForModel).toHaveBeenCalledWith({ maxSeqLen: 4096 })
    expect(fake.loadModel).toHaveBeenCalledWith(
      'model',
      { maxSeqLen: 4096 },
      expect.any(Function)
    )
  })

  it('restarts an owned Ollama runtime for a changed context fingerprint', async () => {
    const fake = fakeProvider({
      running: true,
      owned: true,
      decision: {
        action: 'restart-provider',
        fingerprint: 'ctx-16384',
        reason: 'context-changed'
      }
    })
    const setup = coordinator(fake.provider)

    await setup.value.load({
      ref: { providerId: 'ollama', modelId: 'model' },
      profile: { keepAlive: '30m', numCtx: 16384 }
    })

    expect(setup.clearRuntimeRegistries).toHaveBeenCalledOnce()
    expect(fake.restartForModel).toHaveBeenCalledWith({
      keepAlive: '30m',
      numCtx: 16384
    })
  })

  it('never restarts an external process', async () => {
    const fake = fakeProvider({
      id: 'tabby',
      running: true,
      owned: false,
      decision: {
        action: 'restart-provider',
        fingerprint: 'unknown',
        reason: 'runtime-unverified'
      }
    })
    const setup = coordinator(fake.provider, 'tabby')

    await expect(
      setup.value.load({
        ref: { providerId: 'tabby', modelId: 'model' },
        profile: { maxSeqLen: 4096 }
      })
    ).rejects.toThrow('EXTERNAL_RUNTIME_RESTART_FORBIDDEN')
    expect(fake.restartForModel).not.toHaveBeenCalled()
    expect(fake.loadModel).not.toHaveBeenCalled()
  })

  it('reuses only a matching provider fingerprint', async () => {
    const fake = fakeProvider({
      running: true,
      decision: {
        action: 'reuse',
        fingerprint: 'same',
        reason: 'compatible'
      }
    })
    const setup = coordinator(fake.provider)

    await expect(
      setup.value.load({
        ref: { providerId: 'ollama', modelId: 'model' },
        profile: ollamaProfile
      })
    ).resolves.toEqual({ ok: true, action: 'reuse' })
    expect(fake.loadModel).not.toHaveBeenCalled()
    expect(fake.restartForModel).not.toHaveBeenCalled()
  })
})
