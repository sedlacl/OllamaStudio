import type { ModelSpeedTestResult } from './client'
import { sanitizeSpeedTestResult } from '../security/sanitize-state'
import { modelRefKey, type BackendId, type ModelRef } from '../../shared/backend-contract'

/**
 * Poslední výsledek testu rychlosti pro každý model. Drží se v paměti hlavního
 * procesu, aby čísla byla stejná na Přehledu, GPU i Modelech; po uvolnění modelu
 * se záznam maže, protože platí pro konkrétní načtený runner.
 */
const registry = new Map<string, { ref: ModelRef; result: ModelSpeedTestResult }>()

function asRef(value: string | ModelRef, providerId: BackendId = 'ollama'): ModelRef {
  return typeof value === 'string' ? { providerId, modelId: value } : value
}

export function recordSpeedTest(
  value: string | ModelRef,
  result: ModelSpeedTestResult,
  providerId: BackendId = 'ollama'
): void {
  const ref = asRef(value, providerId)
  if (!ref.modelId.trim()) return
  registry.set(modelRefKey(ref), { ref, result: sanitizeSpeedTestResult(result) })
}

export function removeSpeedTest(
  value: string | ModelRef,
  providerId: BackendId = 'ollama'
): void {
  const ref = asRef(value, providerId)
  if (!ref.modelId.trim()) return
  registry.delete(modelRefKey(ref))
}

export function getSpeedTests(): Record<string, ModelSpeedTestResult> {
  const out: Record<string, ModelSpeedTestResult> = {}
  for (const { ref, result } of registry.values()) {
    // Legacy renderer zatím zobrazuje pouze aktivního providera.
    out[ref.modelId.trim().toLowerCase()] = sanitizeSpeedTestResult(result)
  }
  return out
}

export function getSpeedTest(ref: ModelRef): ModelSpeedTestResult | null {
  const stored = registry.get(modelRefKey(ref))
  return stored ? sanitizeSpeedTestResult(stored.result) : null
}

export function clearAllSpeedTests(): void {
  registry.clear()
}
