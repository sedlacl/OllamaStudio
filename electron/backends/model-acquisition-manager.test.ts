import { describe, expect, it, vi } from 'vitest'

vi.mock('./registry', () => ({
  getAllProviders: () => [],
  getProvider: () => {
    throw new Error('test dependency not configured')
  }
}))
vi.mock('../tabby/active-backend', () => ({
  switchActiveBackendForModel: async () => {}
}))
vi.mock('../ollama/config', () => ({
  getActiveBackend: () => 'ollama'
}))

import type {
  AcquisitionState,
  BackendId,
  ModelAcquisitionRequest,
  ModelAcquisitionResult
} from '../../shared/backend-contract'
import type { BackendProvider } from './provider'
import { ModelAcquisitionManager } from './model-acquisition-manager'

function fakeProvider(
  id: BackendId,
  options?: {
    running?: boolean
    restored?: AcquisitionState[]
    acquire?: (
      request: ModelAcquisitionRequest,
      operationId: string,
      progress: (state: Partial<AcquisitionState>) => void
    ) => Promise<ModelAcquisitionResult>
  }
): BackendProvider {
  let running = options?.running ?? true
  return {
    id,
    initializeAcquisition: vi.fn(async () => options?.restored ?? []),
    resolveAcquisitionModelId: vi.fn((request: ModelAcquisitionRequest) =>
      request.providerId === 'ollama'
        ? request.modelId
        : request.folderName ?? request.modelId ?? request.repoId.split('/').pop() ?? ''
    ),
    isRunning: vi.fn(() => running),
    getServeState: vi.fn(() => ({ status: running ? 'running' : 'stopped' })),
    start: vi.fn(async () => {
      running = true
      return { status: 'running' }
    }),
    acquireModel:
      options?.acquire ??
      vi.fn(async (_request, operationId, progress) => {
        progress({
          status: 'running',
          bytesDownloaded: 25,
          bytesTotal: 100,
          percent: 25
        })
        return { ok: true, operationId }
      }),
    dismissAcquisition: vi.fn(async () => {})
  } as unknown as BackendProvider
}

function managerWith(
  providers: Record<BackendId, BackendProvider>,
  active: BackendId = 'ollama'
): {
  manager: ModelAcquisitionManager
  switchProvider: ReturnType<typeof vi.fn>
} {
  const switchProvider = vi.fn(async () => {})
  return {
    manager: new ModelAcquisitionManager({
      getActiveProviderId: () => active,
      getProvider: (id) => providers[id],
      getProviders: () => Object.values(providers),
      switchProvider,
      invalidateCatalog: vi.fn(),
      now: () => 1_000
    }),
    switchProvider
  }
}

describe('ModelAcquisitionManager', () => {
  it('odmítne neznámá pole na IPC hranici', async () => {
    const ollama = fakeProvider('ollama')
    const tabby = fakeProvider('tabby')
    const { manager } = managerWith({ ollama, tabby })
    await expect(
      manager.start({
        providerId: 'tabby',
        source: 'hugging-face',
        repoId: 'org/model',
        password: 'must-not-cross-boundary'
      } as never)
    ).rejects.toThrow('INVALID_ACQUISITION_REQUEST')
  })

  it('normalizuje Ollama i Tabby progress do stejného provider-qualified tvaru', async () => {
    const ollama = fakeProvider('ollama')
    const tabby = fakeProvider('tabby')
    const { manager } = managerWith({ ollama, tabby })
    const emitted: AcquisitionState[] = []
    await manager.initialize('unused', (state) => emitted.push(state))

    await manager.start({
      providerId: 'ollama',
      source: 'library',
      modelId: 'qwen:latest'
    })
    await manager.start({
      providerId: 'tabby',
      source: 'hugging-face',
      repoId: 'org/qwen',
      folderName: 'qwen-exl3'
    })

    const progress = emitted.filter((state) => state.percent === 25)
    expect(progress).toHaveLength(2)
    expect(progress.map(({ providerId, modelId, bytesDownloaded, bytesTotal, percent }) => ({
      providerId,
      modelId,
      bytesDownloaded,
      bytesTotal,
      percent
    }))).toEqual([
      {
        providerId: 'ollama',
        modelId: 'qwen:latest',
        bytesDownloaded: 25,
        bytesTotal: 100,
        percent: 25
      },
      {
        providerId: 'tabby',
        modelId: 'qwen-exl3',
        bytesDownloaded: 25,
        bytesTotal: 100,
        percent: 25
      }
    ])
  })

  it('nemění běžící provider a zastavený aktivuje přes default start bez profilu', async () => {
    const ollama = fakeProvider('ollama', { running: true })
    const tabby = fakeProvider('tabby', { running: false })
    const { manager, switchProvider } = managerWith({ ollama, tabby }, 'ollama')
    await manager.initialize('unused', () => {})

    await manager.start({
      providerId: 'ollama',
      source: 'library',
      modelId: 'qwen'
    })
    expect(ollama.start).not.toHaveBeenCalled()

    await manager.start({
      providerId: 'tabby',
      source: 'hugging-face',
      repoId: 'org/model'
    })
    expect(switchProvider).toHaveBeenCalledWith('tabby')
    expect(tabby.start).toHaveBeenCalledWith()
  })

  it('obnoví interrupted/conflict stav a dismiss předá provideru', async () => {
    const restored: AcquisitionState = {
      providerId: 'tabby',
      modelId: 'partial-model',
      operationId: 'dl-restored',
      status: 'interrupted',
      bytesDownloaded: 40,
      bytesTotal: 100,
      percent: 40,
      startedAt: 10,
      updatedAt: 20,
      details: {
        folderConflict: {
          folderName: 'partial-model',
          completeness: 'partial'
        }
      }
    }
    const tabby = fakeProvider('tabby', { restored: [restored] })
    const ollama = fakeProvider('ollama')
    const { manager } = managerWith({ ollama, tabby })
    await manager.initialize('unused', () => {})

    expect(manager.getAll()).toContainEqual(restored)
    await manager.dismiss('dl-restored')
    expect(tabby.dismissAcquisition).toHaveBeenCalledWith('dl-restored')
    expect(manager.getAll()).toEqual([])
  })

  it('zachová provider conflict jako terminální unified stav', async () => {
    const tabby = fakeProvider('tabby', {
      acquire: vi.fn(async (_request, operationId) => ({
        ok: false,
        operationId,
        error: 'folder exists',
        details: {
          status: 'conflict',
          folderConflict: {
            folderName: 'model',
            completeness: 'partial'
          }
        }
      }))
    })
    const ollama = fakeProvider('ollama')
    const { manager } = managerWith({ ollama, tabby })
    await manager.initialize('unused', () => {})
    const result = await manager.start({
      providerId: 'tabby',
      source: 'hugging-face',
      repoId: 'org/model',
      folderName: 'model'
    })

    expect(result.ok).toBe(false)
    expect(manager.getAll()[0]).toMatchObject({
      providerId: 'tabby',
      modelId: 'model',
      status: 'conflict'
    })
  })

  it('nepropustí jednorázový token do eventu, výsledku ani uloženého stavu', async () => {
    const token = 'opaque-private-value-123456'
    const tabby = fakeProvider('tabby', {
      acquire: vi.fn(async (_request, operationId, progress) => {
        progress({
          status: 'running',
          error: `Bearer ${token}`,
          details: { token, nested: `failed with ${token}` }
        })
        return {
          ok: false,
          operationId,
          error: `download failed: ${token}`,
          details: { status: 'error', token, message: token }
        }
      })
    })
    const ollama = fakeProvider('ollama')
    const { manager } = managerWith({ ollama, tabby })
    const emitted: AcquisitionState[] = []
    await manager.initialize('unused', (state) => emitted.push(state))
    const result = await manager.start({
      providerId: 'tabby',
      source: 'hugging-face',
      repoId: 'private/model',
      token
    })

    expect(JSON.stringify({ result, emitted, states: manager.getAll() })).not.toContain(token)
    expect(JSON.stringify(manager.getAll())).not.toMatch(/"token"\s*:/i)
  })
})
