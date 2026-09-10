import {
  modelRefKey,
  type AggregatedModelCatalog,
  type CatalogModel
} from '../../shared/backend-contract'
import type { BackendProvider } from './provider'
import { getAllProviders } from './registry'

type CatalogProvider = Pick<
  BackendProvider,
  'id' | 'discoverModels' | 'getServeState' | 'listLoaded'
>

export class ModelCatalog {
  private invalidation = 0

  constructor(private readonly providers: () => CatalogProvider[] = getAllProviders) {}

  invalidate(): void {
    this.invalidation += 1
  }

  async refresh(): Promise<AggregatedModelCatalog> {
    const refreshGeneration = this.invalidation
    const providers = this.providers()
    const settled = await Promise.allSettled(
      providers.map(async (provider) => {
        const models = await provider.discoverModels()
        const loaded = new Set<string>()
        if (provider.getServeState().endpointStatus === 'healthy') {
          try {
            for (const model of await provider.listLoaded()) {
              const modelId = model.model || model.name
              if (modelId) loaded.add(modelRefKey({ providerId: provider.id, modelId }))
            }
          } catch {
            // Loaded state je best-effort; offline katalog zůstane platný.
          }
        }
        return models.map<CatalogModel>((model) => ({
          ...model,
          loaded: loaded.has(modelRefKey(model))
        }))
      })
    )

    const models: CatalogModel[] = []
    const states = settled.map((result, index) => {
      const providerId = providers[index].id
      if (result.status === 'fulfilled') {
        models.push(...result.value)
        return {
          providerId,
          status: 'ok' as const,
          modelCount: result.value.length
        }
      }
      return {
        providerId,
        status: 'error' as const,
        modelCount: 0,
        error: { code: 'CATALOG_DISCOVERY_FAILED' }
      }
    })

    models.sort(
      (left, right) =>
        left.providerId.localeCompare(right.providerId) ||
        left.displayName.localeCompare(right.displayName)
    )
    // Akvizice mohla dokončit během I/O; starý snapshot v tom případě nepoužijeme.
    if (refreshGeneration !== this.invalidation) return this.refresh()
    return { models, providers: states, refreshedAt: Date.now() }
  }
}

export const modelCatalog = new ModelCatalog()
