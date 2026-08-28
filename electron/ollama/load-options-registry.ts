import type { ModelLoadOptions } from './client'

export interface RecordedLoadOptions {
  modelName: string
  options: ModelLoadOptions
  recordedAt: number
}

/** Normalize model names for registry lookup (case-insensitive, trim). */
export function canonicalizeModelName(name: string): string {
  return name.trim().toLowerCase()
}

const registry = new Map<string, RecordedLoadOptions>()

export function recordLoadOptions(name: string, options: ModelLoadOptions): void {
  const key = canonicalizeModelName(name)
  if (!key) return
  registry.set(key, {
    modelName: name.trim(),
    options: { ...options },
    recordedAt: Date.now()
  })
}

export function removeLoadOptions(name: string): void {
  const key = canonicalizeModelName(name)
  if (!key) return
  registry.delete(key)
}

export function getLoadOptions(name: string): RecordedLoadOptions | null {
  const key = canonicalizeModelName(name)
  if (!key) return null
  return registry.get(key) ?? null
}

export function clearAllLoadOptions(): void {
  registry.clear()
}
