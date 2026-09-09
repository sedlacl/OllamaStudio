import { rmSync } from 'fs'
import { afterAll, describe, expect, it, vi } from 'vitest'

const { userDataPath } = vi.hoisted(() => ({
  userDataPath: `${process.env.TEMP ?? process.cwd()}\\ollamastudio-provider-${process.pid}`
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

import { getAllProviders, getProvider, normalizeProviderId } from './registry'

afterAll(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('backend provider registry', () => {
  it('returns the registered provider for every BackendId', () => {
    expect(getProvider('ollama').id).toBe('ollama')
    expect(getProvider('tabby').id).toBe('tabby')
    expect(getAllProviders().map((provider) => provider.id).sort()).toEqual([
      'ollama',
      'tabby'
    ])
  })

  it('normalizes an untrusted backend id to Ollama', () => {
    expect(normalizeProviderId('tabby')).toBe('tabby')
    expect(normalizeProviderId('llamacpp')).toBe('ollama')
    expect(normalizeProviderId(undefined)).toBe('ollama')
  })

  it('exposes capabilities through providers', () => {
    expect(getProvider('ollama').capabilities.pullLibraryTag).toBe(true)
    expect(getProvider('ollama').capabilities.continueIntegration).toBe(true)
    expect(getProvider('tabby').capabilities.hfDownload).toBe(true)
    expect(getProvider('tabby').capabilities.continueIntegration).toBe(false)
  })

  it('rejects unsupported Tabby catalog mutations', async () => {
    const tabby = getProvider('tabby')
    await expect(tabby.deleteModel('model')).rejects.toThrow(
      'Tabby katalog nepodporuje delete'
    )
    await expect(tabby.cloneModel('source', 'destination')).rejects.toThrow(
      'Tabby katalog nepodporuje clone'
    )
    await expect(tabby.pullModel('model', () => undefined)).resolves.toEqual({
      ok: false,
      error: 'Použijte HF download (tabbyDownload)'
    })
  })
})
