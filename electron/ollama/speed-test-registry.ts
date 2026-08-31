import type { ModelSpeedTestResult } from './client'
import { canonicalizeModelName } from './load-options-registry'
import { sanitizeSpeedTestResult } from '../security/sanitize-state'

/**
 * Poslední výsledek testu rychlosti pro každý model. Drží se v paměti hlavního
 * procesu, aby čísla byla stejná na Přehledu, GPU i Modelech; po uvolnění modelu
 * se záznam maže, protože platí pro konkrétní načtený runner.
 */
const registry = new Map<string, ModelSpeedTestResult>()

export function recordSpeedTest(name: string, result: ModelSpeedTestResult): void {
  const key = canonicalizeModelName(name)
  if (!key) return
  registry.set(key, sanitizeSpeedTestResult(result))
}

export function removeSpeedTest(name: string): void {
  const key = canonicalizeModelName(name)
  if (!key) return
  registry.delete(key)
}

export function getSpeedTests(): Record<string, ModelSpeedTestResult> {
  const out: Record<string, ModelSpeedTestResult> = {}
  for (const [key, result] of registry) {
    out[key] = sanitizeSpeedTestResult(result)
  }
  return out
}

export function clearAllSpeedTests(): void {
  registry.clear()
}
