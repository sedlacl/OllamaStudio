import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { userDataPath } = vi.hoisted(() => ({
  userDataPath: `${process.env.TEMP ?? process.cwd()}\\ollamastudio-config-v3-${process.pid}`
}))

vi.mock('electron', () => ({ app: { getPath: () => userDataPath } }))

import { loadConfig, saveConfig } from './config'

beforeEach(() => rmSync(userDataPath, { recursive: true, force: true }))
afterAll(() => rmSync(userDataPath, { recursive: true, force: true }))

describe('config migration v3', () => {
  it('migrates legacy Ollama and Tabby values into provider map', () => {
    const path = join(userDataPath, 'config.json')
    mkdirSync(userDataPath, { recursive: true })
    writeFileSync(path, JSON.stringify({
      configVersion: 2,
      activeBackend: 'tabby',
      language: 'en',
      autoStartServe: false,
      ollamaEnv: {
        OLLAMA_HOST: '10.0.0.2:11434',
        OLLAMA_CONTEXT_LENGTH: '65536',
        OLLAMA_KEEP_ALIVE: '12m'
      },
      tabby: { installDir: 'X:\\Tabby', host: '0.0.0.0', port: 5010, autoStartServe: true }
    }), 'utf-8')

    const config = loadConfig()
    expect(config.providers.ollama.env.OLLAMA_HOST).toBe('10.0.0.2:11434')
    expect(config.providers.ollama.profileDefaults).toEqual({ numCtx: 65536, keepAlive: '12m' })
    expect(config.providers.ollama.autoStartServe).toBe(false)
    expect(config.providers.tabby.installDir).toBe('X:\\Tabby')
    expect(config.activeBackend).toBe('tabby')
    expect(existsSync(join(userDataPath, 'config.json'))).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf-8'))).not.toHaveProperty('ollamaEnv')
    expect(
      readdirSync(userDataPath).some((name) => name.startsWith('config.backup.'))
    ).toBe(true)
  })

  it('round-trips canonical provider config without legacy fields on disk', () => {
    const config = loadConfig()
    config.providers.tabby.port = 6000
    config.tabby.port = 6000
    saveConfig(config)
    const stored = JSON.parse(readFileSync(join(userDataPath, 'config.json'), 'utf-8'))
    expect(stored.configVersion).toBe(3)
    expect(stored.providers.tabby.port).toBe(6000)
    expect(stored).not.toHaveProperty('tabby')
  })

  it('prefers canonical v3 providers over stale transition aliases', () => {
    const path = join(userDataPath, 'config.json')
    mkdirSync(userDataPath, { recursive: true })
    writeFileSync(path, JSON.stringify({
      configVersion: 3,
      activeBackend: 'tabby',
      providers: {
        ollama: {
          env: { OLLAMA_HOST: 'canonical:11434' },
          autoStartServe: false,
          profileDefaults: { keepAlive: '7m', numCtx: 32768 }
        },
        tabby: { host: 'canonical-tabby', port: 5050 }
      },
      ollamaEnv: { OLLAMA_HOST: 'stale:11434' },
      autoStartServe: true,
      tabby: { host: 'stale-tabby', port: 5999 }
    }), 'utf-8')

    const config = loadConfig()
    expect(config.providers.ollama.env.OLLAMA_HOST).toBe('canonical:11434')
    expect(config.providers.ollama.autoStartServe).toBe(false)
    expect(config.providers.ollama.profileDefaults).toEqual({
      keepAlive: '7m',
      numCtx: 32768
    })
    expect(config.providers.tabby).toMatchObject({
      host: 'canonical-tabby',
      port: 5050
    })
  })
})
