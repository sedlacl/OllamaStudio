import type { BackendId } from '../../shared/backend-contract'
import { ollamaRendererProvider } from './ollama'
import { tabbyRendererProvider } from './tabby'
import type { RendererProviderDefinition, RendererProviderRegistry } from './types'

export const RENDERER_PROVIDERS: RendererProviderRegistry = {
  ollama: ollamaRendererProvider,
  tabby: tabbyRendererProvider
}

/** Compile-time: každý `BackendId` musí mít renderer definici. */
const _registryCompleteness = RENDERER_PROVIDERS satisfies RendererProviderRegistry

void _registryCompleteness

export function getRendererProvider<I extends BackendId>(id: I): RendererProviderDefinition<I> {
  return RENDERER_PROVIDERS[id]
}

type RegistryLike = Record<string, RendererProviderDefinition<any>>

export function listRendererProviderIds(
  registry: RegistryLike = RENDERER_PROVIDERS
): string[] {
  return Object.keys(registry)
}

export function assertRendererRegistryMatches(
  descriptors: Array<{ id: string }>,
  registry: RegistryLike = RENDERER_PROVIDERS
): void {
  const descriptorIds = new Set(descriptors.map((d) => d.id))
  for (const id of listRendererProviderIds(registry)) {
    if (!descriptorIds.has(id)) {
      throw new Error(`Renderer provider "${id}" has no main BackendDescriptor`)
    }
  }
  for (const id of descriptorIds) {
    if (!registry[id]) {
      throw new Error(`Main descriptor "${id}" has no renderer provider definition`)
    }
  }
}

export function resolveRendererProviders(
  descriptors: Array<{ id: string }>,
  registry: RegistryLike = RENDERER_PROVIDERS
): RendererProviderDefinition<any>[] {
  assertRendererRegistryMatches(descriptors, registry)
  return descriptors.map(({ id }) => registry[id])
}
