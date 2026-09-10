import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { userDataPath } = vi.hoisted(() => ({
  userDataPath: `${process.env.TEMP ?? process.cwd()}\\ollamastudio-profiles-${process.pid}`
}))

vi.mock('electron', () => ({ app: { getPath: () => userDataPath } }))

import { ModelProfileStore } from './model-profile-store'

beforeEach(() => rmSync(userDataPath, { recursive: true, force: true }))
afterAll(() => rmSync(userDataPath, { recursive: true, force: true }))

describe('ModelProfileStore', () => {
  it('persists provider-qualified models without key collisions', () => {
    const path = join(userDataPath, 'profiles.json')
    const store = new ModelProfileStore(path)
    store.save({ providerId: 'ollama', modelId: 'same:model' }, { keepAlive: '5m', numCtx: 8192 })
    store.save({ providerId: 'tabby', modelId: 'same:model' }, { maxSeqLen: 32768, vision: true })

    const reopened = new ModelProfileStore(path)
    expect(reopened.getStored({ providerId: 'ollama', modelId: 'SAME:MODEL' })?.profile.numCtx).toBe(8192)
    expect(reopened.getStored({ providerId: 'tabby', modelId: 'same:model' })?.profile.maxSeqLen).toBe(32768)
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf-8')).profiles)).toHaveLength(2)
  })

  it('uses atomic replacement and leaves no temporary files', () => {
    const path = join(userDataPath, 'profiles.json')
    const store = new ModelProfileStore(path)
    store.save({ providerId: 'ollama', modelId: 'a' }, { keepAlive: '1m', numCtx: 4096 })
    store.save({ providerId: 'ollama', modelId: 'a' }, { keepAlive: '2m', numCtx: 8192 })

    expect(store.get({ providerId: 'ollama', modelId: 'a' })).toMatchObject({
      keepAlive: '2m',
      numCtx: 8192
    })
    expect(readdirSync(userDataPath).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('rekeys valid legacy entries and ignores unknown providers', () => {
    const path = join(userDataPath, 'profiles.json')
    mkdirSync(userDataPath, { recursive: true })
    writeFileSync(path, JSON.stringify({
      version: 1,
      profiles: {
        'legacy-freeform-key': {
          ref: { providerId: 'ollama', modelId: ' MixedCase:Latest ' },
          schemaVersion: 1,
          updatedAt: 123,
          profile: { keepAlive: '9m', numCtx: 16384 }
        },
        untrusted: {
          ref: { providerId: 'plugin-from-disk', modelId: 'model' },
          schemaVersion: 1,
          updatedAt: 456,
          profile: { token: 'must-not-load' }
        }
      }
    }), 'utf-8')

    const store = new ModelProfileStore(path)
    expect(store.getStored({
      providerId: 'ollama',
      modelId: 'mixedcase:latest'
    })).toMatchObject({
      updatedAt: 123,
      profile: { keepAlive: '9m', numCtx: 16384 }
    })
    expect(store.getStored({
      providerId: 'tabby',
      modelId: 'model'
    })).toBeNull()
  })
})
