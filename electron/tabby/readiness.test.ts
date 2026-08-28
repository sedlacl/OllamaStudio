import { describe, expect, it } from 'vitest'
import { SingleFlight, waitForHealthy } from './readiness'

describe('Tabby readiness race', () => {
  it('coalesces rapid starts and releases all callers only after readiness', async () => {
    const gate = new SingleFlight()
    let starts = 0
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const operation = async (): Promise<void> => {
      starts += 1
      await ready
    }

    let firstDone = false
    const first = gate.run(operation).then(() => {
      firstDone = true
    })
    const second = gate.run(operation)
    await Promise.resolve()

    expect(starts).toBe(1)
    expect(firstDone).toBe(false)
    release()
    await Promise.all([first, second])
    expect(firstDone).toBe(true)
  })

  it('waits through connection refusal until the health probe is truly healthy', async () => {
    let now = 0
    let probes = 0
    const healthy = await waitForHealthy({
      timeoutMs: 1_000,
      intervalMs: 100,
      now: () => now,
      delay: async (ms) => {
        now += ms
      },
      probe: async () => {
        probes += 1
        return probes === 3
      }
    })
    expect(healthy).toBe(true)
    expect(probes).toBe(3)
    expect(now).toBe(200)
  })

  it('returns false at a bounded timeout', async () => {
    let now = 0
    const healthy = await waitForHealthy({
      timeoutMs: 250,
      intervalMs: 100,
      now: () => now,
      delay: async (ms) => {
        now += ms
      },
      probe: async () => false
    })
    expect(healthy).toBe(false)
    expect(now).toBe(250)
  })
})
