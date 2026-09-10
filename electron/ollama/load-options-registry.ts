import type { ModelLoadOptions } from './client'
import {
  canonicalizeModelRef,
  modelRefKey,
  type BackendId,
  type ModelRef
} from '../../shared/backend-contract'

export interface RecordedLoadOptions {
  ref: ModelRef
  modelName: string
  options: ModelLoadOptions
  recordedAt: number
}

function asRef(value: string | ModelRef, providerId: BackendId = 'ollama'): ModelRef {
  return typeof value === 'string' ? { providerId, modelId: value } : value
}

/** Legacy helper; nové registry používají provider-qualified ModelRef. */
export function canonicalizeModelName(name: string): string {
  return canonicalizeModelRef({ providerId: 'ollama', modelId: name }).modelId
}

const registry = new Map<string, RecordedLoadOptions>()

export function recordLoadOptions(
  value: string | ModelRef,
  options: ModelLoadOptions,
  providerId: BackendId = 'ollama'
): void {
  const ref = asRef(value, providerId)
  if (!ref.modelId.trim()) return
  const key = modelRefKey(ref)
  registry.set(key, {
    ref: { providerId: ref.providerId, modelId: ref.modelId.trim() },
    modelName: ref.modelId.trim(),
    options: { ...options },
    recordedAt: Date.now()
  })
}

export function removeLoadOptions(
  value: string | ModelRef,
  providerId: BackendId = 'ollama'
): void {
  const ref = asRef(value, providerId)
  if (!ref.modelId.trim()) return
  registry.delete(modelRefKey(ref))
}

export function getLoadOptions(
  value: string | ModelRef,
  providerId: BackendId = 'ollama'
): RecordedLoadOptions | null {
  const ref = asRef(value, providerId)
  if (!ref.modelId.trim()) return null
  return registry.get(modelRefKey(ref)) ?? null
}

export function clearAllLoadOptions(): void {
  registry.clear()
}
