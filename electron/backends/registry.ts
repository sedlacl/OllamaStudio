import { getActiveBackend } from '../ollama/config'
import { ollamaProvider } from './ollama-provider'
import type { BackendProvider } from './provider'
import { tabbyProvider } from './tabby-provider'
import type { BackendId } from './types'

const providers: Record<BackendId, BackendProvider> = {
  ollama: ollamaProvider,
  tabby: tabbyProvider
}

export function getProvider(id: BackendId): BackendProvider {
  return providers[id]
}

export function normalizeProviderId(value: unknown): BackendId {
  return value === 'tabby' ? 'tabby' : 'ollama'
}

export function getActiveProvider(): BackendProvider {
  return getProvider(getActiveBackend())
}

export function getAllProviders(): BackendProvider[] {
  return Object.values(providers)
}
