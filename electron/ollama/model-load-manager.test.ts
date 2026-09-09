import { afterEach, describe, expect, it } from 'vitest'
import {
  clearModelLoadState,
  getActiveModelLoads,
  startBackgroundModelLoad
} from './model-load-manager'

afterEach(() => {
  for (const load of getActiveModelLoads()) {
    clearModelLoadState(load.name)
  }
})

describe('startBackgroundModelLoad', () => {
  it('returns immediately and marks the model as loading', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })

    const result = startBackgroundModelLoad('qwen-test', () => pending)
    expect(result).toEqual({ ok: true })
    expect(getActiveModelLoads()).toEqual([
      expect.objectContaining({ name: 'qwen-test', status: 'loading' })
    ])

    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(getActiveModelLoads().some((s) => s.name === 'qwen-test' && s.status === 'success')).toBe(
      true
    )
  })

  it('rejects a second load of the same model while the first is in flight', () => {
    void startBackgroundModelLoad('qwen-test', () => new Promise(() => {}))
    const second = startBackgroundModelLoad('qwen-test', async () => {})
    expect(second.ok).toBe(false)
    expect(second.error).toMatch(/qwen-test/)
  })
})
