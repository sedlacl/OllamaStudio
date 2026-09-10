import { rmSync } from 'fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { BackendProvider } from './provider'

const { userDataPath } = vi.hoisted(() => ({
  userDataPath: `${process.env.TEMP ?? process.cwd()}\\ollamastudio-catalog-${process.pid}`
}))

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath }
}))

import { ModelCatalog } from './model-catalog'

afterAll(() => rmSync(userDataPath, { recursive: true, force: true }))

function provider(
  id: 'ollama' | 'tabby',
  overrides: Partial<BackendProvider>
): BackendProvider {
  return {
    id,
    discoverModels: async () => [],
    listLoaded: async () => [],
    getServeState: () => ({
      backend: id,
      processStatus: 'stopped',
      endpointStatus: 'unreachable',
      status: 'stopped',
      pid: null,
      spawnTime: null,
      binaryPath: null,
      error: null,
      portConflict: false,
      ownedByStudio: false,
      auth: { hasApiKey: false, hasAdminKey: false, disableAuth: false }
    }),
    ...overrides
  } as BackendProvider
}

describe('aggregated model catalog', () => {
  it('returns healthy provider data when another discovery fails', async () => {
    const ollama = provider('ollama', {
      discoverModels: async () => [
        {
          providerId: 'ollama',
          modelId: 'same:latest',
          displayName: 'same:latest',
          sizeBytes: 10
        }
      ]
    })
    const tabby = provider('tabby', {
      discoverModels: async () => {
        throw new Error('sensitive disk path')
      }
    })

    const result = await new ModelCatalog(() => [ollama, tabby]).refresh()
    expect(result.models).toEqual([
      expect.objectContaining({ providerId: 'ollama', modelId: 'same:latest' })
    ])
    expect(result.providers).toEqual([
      { providerId: 'ollama', status: 'ok', modelCount: 1 },
      {
        providerId: 'tabby',
        status: 'error',
        modelCount: 0,
        error: { code: 'CATALOG_DISCOVERY_FAILED' }
      }
    ])
    expect(JSON.stringify(result)).not.toContain('sensitive disk path')
  })

  it('adds loaded state only from an already healthy endpoint', async () => {
    const listLoaded = vi.fn(async () => [
      {
        name: 'model',
        model: 'model',
        size: 1,
        digest: '',
        expires_at: ''
      }
    ])
    const tabby = provider('tabby', {
      discoverModels: async () => [
        {
          providerId: 'tabby',
          modelId: 'model',
          displayName: 'model',
          sizeBytes: null
        }
      ],
      listLoaded,
      getServeState: () => ({
        backend: 'tabby',
        processStatus: 'external',
        endpointStatus: 'healthy',
        status: 'running',
        pid: null,
        spawnTime: null,
        binaryPath: null,
        error: null,
        portConflict: false,
        ownedByStudio: false,
        auth: { hasApiKey: true, hasAdminKey: true, disableAuth: false }
      })
    })

    const result = await new ModelCatalog(() => [tabby]).refresh()
    expect(listLoaded).toHaveBeenCalledOnce()
    expect(result.models[0].loaded).toBe(true)
  })
})
