import { rmSync } from 'fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { modelRefKey } from '../../shared/backend-contract'

const { userDataPath } = vi.hoisted(() => ({
  userDataPath: `${process.env.TEMP ?? process.cwd()}\\ollamastudio-compat-${process.pid}`
}))

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath }
}))

import { profileFingerprint } from './definitions'
import { OllamaProvider } from './ollama-provider'
import { TabbyProvider } from './tabby-provider'
import { tabbyClient } from '../tabby/client'
import { serveManager } from '../ollama/serve-manager'

afterAll(() => rmSync(userDataPath, { recursive: true, force: true }))

describe('provider compatibility fingerprints', () => {
  it('forces an Ollama runtime restart when context changes or is unknown', async () => {
    const provider = new OllamaProvider()
    vi.spyOn(provider, 'isRunning').mockReturnValue(true)
    const runtime = provider as unknown as { runtimeContext: number | null }
    runtime.runtimeContext = null

    await expect(
      provider.decideModelCompatibility(
        { providerId: 'ollama', modelId: 'model' },
        { keepAlive: '30m', numCtx: 8192 }
      )
    ).resolves.toMatchObject({
      action: 'restart-provider',
      reason: 'runtime-unverified'
    })

    runtime.runtimeContext = 4096
    await expect(
      provider.decideModelCompatibility(
        { providerId: 'ollama', modelId: 'model' },
        { keepAlive: '30m', numCtx: 8192 }
      )
    ).resolves.toMatchObject({
      action: 'restart-provider',
      reason: 'context-changed'
    })
  })

  it('reuses Ollama only when model and normalized profile fingerprint match', async () => {
    const provider = new OllamaProvider()
    const ref = { providerId: 'ollama' as const, modelId: 'model' }
    const profile = { keepAlive: '30m', numCtx: 8192, useMmap: true }
    vi.spyOn(provider, 'isRunning').mockReturnValue(true)
    vi.spyOn(provider, 'listLoaded').mockResolvedValue([
      { name: 'model', model: 'model', size: 1, digest: '', expires_at: '' }
    ])
    const internals = provider as unknown as {
      runtimeContext: number | null
      loadedFingerprints: Map<string, string>
    }
    internals.runtimeContext = 8192
    internals.loadedFingerprints.set(modelRefKey(ref), profileFingerprint('ollama', profile))

    await expect(provider.decideModelCompatibility(ref, profile)).resolves.toMatchObject({
      action: 'reuse',
      reason: 'compatible'
    })
    await expect(
      provider.decideModelCompatibility(ref, { ...profile, useMmap: false })
    ).resolves.toMatchObject({
      action: 'reload-model',
      reason: 'profile-changed'
    })
  })

  it('starts Ollama with the resolved profile context as a runtime override', async () => {
    const provider = new OllamaProvider()
    const start = vi.spyOn(serveManager, 'start').mockResolvedValue()
    vi.spyOn(serveManager, 'getState').mockReturnValue({
      status: 'running',
      pid: 42,
      spawnTime: 1,
      binaryPath: 'ollama',
      error: null,
      portConflict: false
    })

    await provider.startForModel({ keepAlive: '30m', numCtx: 32768 })

    expect(start).toHaveBeenCalledWith(false, {
      OLLAMA_CONTEXT_LENGTH: '32768'
    })
  })

  it('treats an adopted Tabby model with unknown fingerprint as reload-only', async () => {
    const provider = new TabbyProvider()
    vi.spyOn(provider, 'isRunning').mockReturnValue(true)
    vi.spyOn(tabbyClient, 'getCurrentModel').mockResolvedValue({
      modelId: 'model',
      displayName: 'model',
      backend: 'tabby'
    })

    await expect(
      provider.decideModelCompatibility(
        { providerId: 'tabby', modelId: 'model' },
        { maxSeqLen: 8192 }
      )
    ).resolves.toMatchObject({
      action: 'reload-model',
      reason: 'runtime-unverified'
    })
  })
})
