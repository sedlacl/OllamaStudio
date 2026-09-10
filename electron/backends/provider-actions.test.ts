import { describe, expect, it, vi } from 'vitest'

vi.mock('./registry', () => ({
  getProvider: () => {
    throw new Error('test dependency not configured')
  }
}))

import type { BackendProvider } from './provider'
import {
  invokeProviderAction,
  validateProviderActionRequest
} from './provider-actions'

describe('provider-qualified actions', () => {
  it('odmítne action mimo provider namespace', () => {
    expect(() =>
      validateProviderActionRequest({
        providerId: 'ollama',
        action: 'hf.refs',
        payload: { repoId: 'org/model' }
      })
    ).toThrow('INVALID_PROVIDER_ACTION')
    expect(() =>
      validateProviderActionRequest({
        providerId: 'tabby',
        action: 'hf.refs',
        payload: { repoId: 123, token: { secret: true } }
      })
    ).toThrow('INVALID_PROVIDER_ACTION')
  })

  it('update action nepřijme příkaz ani argumenty z rendereru', () => {
    for (const action of [
      'runtime.update-installer-status',
      'runtime.open-update-terminal'
    ]) {
      expect(() =>
        validateProviderActionRequest({
          providerId: 'ollama',
          action,
          payload: { command: 'calc.exe', args: ['renderer-value'] }
        })
      ).toThrow('INVALID_PROVIDER_ACTION')
    }
    expect(
      validateProviderActionRequest({
        providerId: 'ollama',
        action: 'runtime.open-update-terminal',
        payload: {}
      })
    ).toEqual({
      providerId: 'ollama',
      action: 'runtime.open-update-terminal',
      payload: {}
    })
  })

  it('dispatchuje pouze validovaný namespaced payload', async () => {
    const invokeAction = vi.fn(async () => ({
      ok: true,
      revisions: [{ name: 'main', type: 'branch' }]
    }))
    const provider = { invokeAction } as unknown as BackendProvider
    const result = await invokeProviderAction(
      {
        providerId: 'tabby',
        action: 'hf.refs',
        payload: { repoId: 'org/model' }
      },
      () => provider
    )

    expect(invokeAction).toHaveBeenCalledWith('hf.refs', {
      repoId: 'org/model'
    })
    expect(result).toEqual({
      ok: true,
      revisions: [{ name: 'main', type: 'branch' }]
    })
  })
})
