import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { userDataPath } = vi.hoisted(() => ({
  userDataPath: `${process.env.TEMP ?? process.cwd()}\\ollamastudio-presets-${process.pid}`
}))

vi.mock('electron', () => ({ app: { getPath: () => userDataPath } }))

import { importPresetJson, listPresets } from './presets'

beforeEach(() => rmSync(userDataPath, { recursive: true, force: true }))
afterAll(() => rmSync(userDataPath, { recursive: true, force: true }))

describe('provider-scoped preset migration', () => {
  it('migrates a legacy load store into the versioned Ollama profile store', () => {
    const dir = join(userDataPath, 'presets')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'load.json'), JSON.stringify({
      version: 1,
      presets: [{
        id: 'legacy-1',
        name: 'Legacy',
        kind: 'load',
        updatedAt: 42,
        data: {
          keepInMemory: true,
          ttl: '30m',
          numCtx: '8192',
          numBatch: '',
          numGpu: '-1',
          numThread: '',
          useMmap: true,
          useMlock: false,
          ropeBase: '',
          ropeScale: ''
        }
      }]
    }), 'utf-8')

    const [preset] = listPresets('load')
    expect(preset).toMatchObject({
      id: 'legacy-1',
      providerId: 'ollama',
      scope: 'model-profile',
      schemaVersion: 1
    })
    expect(preset.data.useMmap).toBe('on')
    const migrated = JSON.parse(readFileSync(join(dir, 'ollama.model-profile.json'), 'utf-8'))
    expect(migrated.version).toBe(2)
    expect(migrated.presets[0]).not.toHaveProperty('kind')
  })

  it('rejects provider mismatches and never derives a path from preset name', () => {
    expect(() => importPresetJson('load', JSON.stringify({
      providerId: 'tabby',
      scope: 'model-profile',
      schemaVersion: 1,
      name: '..\\..\\escape',
      data: { keepInMemory: true, ttl: '1m' }
    }))).toThrow()

    importPresetJson('load', JSON.stringify({
      providerId: 'ollama',
      scope: 'model-profile',
      schemaVersion: 1,
      name: '..\\..\\escape',
      data: { keepInMemory: true, ttl: '1m' }
    }))
    expect(existsSync(join(userDataPath, 'escape.json'))).toBe(false)
    expect(existsSync(join(userDataPath, 'presets', 'ollama.model-profile.json'))).toBe(true)
  })
})
