import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { homePath, userDataPath } = vi.hoisted(() => {
  const root = `${process.env.TEMP ?? process.cwd()}\\ollamastudio-continue-${process.pid}`
  return {
    homePath: `${root}\\home`,
    userDataPath: `${root}\\user-data`
  }
})

vi.mock('electron', () => ({ app: { getPath: () => userDataPath } }))
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => homePath
}))

import { loadConfig, saveConfig } from './config'
import {
  buildContinueSettingsFor,
  matchContinueModel,
  upsertContinueModel
} from './continue-config'

beforeEach(() => {
  rmSync(homePath, { recursive: true, force: true })
  rmSync(userDataPath, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(join(homePath, '..'), { recursive: true, force: true })
})

describe('Continue provider-qualified integration', () => {
  it('uses the requested Ollama profile even while Tabby is active', () => {
    const config = loadConfig()
    config.activeBackend = 'tabby'
    config.providers.ollama.env.OLLAMA_HOST = '10.0.0.8:11434'
    config.ollamaEnv.OLLAMA_HOST = '10.0.0.8:11434'
    saveConfig(config)

    const ref = { providerId: 'ollama' as const, modelId: 'Qwen:latest' }
    const profile = { keepAlive: '30m', numCtx: 65536 }
    expect(buildContinueSettingsFor(ref, profile)).toMatchObject({
      model: 'Qwen',
      apiBase: 'http://10.0.0.8:11434',
      contextLength: 65536
    })

    const entry = upsertContinueModel(ref, profile)
    expect(entry.ref.providerId).toBe('ollama')
    expect(entry.contextLength).toBe(65536)
    expect(matchContinueModel(ref, profile).state).toBe('current')
    const path = join(homePath, '.continue', 'config.yaml')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toContain('contextLength: 65536')
  })

  it('fails closed for a provider without Continue capability', () => {
    const ref = { providerId: 'tabby' as const, modelId: 'same-name' }
    expect(matchContinueModel(ref, { maxSeqLen: 32768 } as never).state).toBe('no-config')
    expect(() => upsertContinueModel(ref, { maxSeqLen: 32768 } as never)).toThrow(
      'CONTINUE_UNSUPPORTED_PROVIDER'
    )
  })
})
