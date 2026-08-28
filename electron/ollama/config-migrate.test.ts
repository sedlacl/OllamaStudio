import { describe, expect, it } from 'vitest'

/**
 * Pure migrace bez Electron app — zrcadlí pravidla z electron/ollama/config.ts.
 */
function normalizeBackend(value: unknown): 'ollama' | 'tabby' {
  return value === 'tabby' ? 'tabby' : 'ollama'
}

function migrateV2(parsed: {
  configVersion?: number
  activeBackend?: unknown
  ollamaEnv?: Record<string, string>
}): {
  configVersion: number
  activeBackend: 'ollama' | 'tabby'
  migrated: boolean
} {
  const fromVersion = parsed.configVersion ?? 0
  let migrated = fromVersion < 2
  const activeBackend =
    fromVersion < 2 ? 'ollama' : normalizeBackend(parsed.activeBackend)
  return {
    configVersion: 2,
    activeBackend,
    migrated: migrated || fromVersion < 2
  }
}

describe('config migration v2', () => {
  it('defaults existing installs to ollama', () => {
    const result = migrateV2({
      configVersion: 1,
      ollamaEnv: { OLLAMA_HOST: '127.0.0.1:11434' }
    })
    expect(result.activeBackend).toBe('ollama')
    expect(result.configVersion).toBe(2)
    expect(result.migrated).toBe(true)
  })

  it('preserves tabby when already on v2', () => {
    const result = migrateV2({
      configVersion: 2,
      activeBackend: 'tabby'
    })
    expect(result.activeBackend).toBe('tabby')
    expect(result.migrated).toBe(false)
  })

  it('rejects unknown backend ids', () => {
    expect(normalizeBackend('llama')).toBe('ollama')
    expect(normalizeBackend(undefined)).toBe('ollama')
  })
})
