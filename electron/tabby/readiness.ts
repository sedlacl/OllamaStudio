export class SingleFlight {
  private active: Promise<void> | null = null

  run(operation: () => Promise<void>): Promise<void> {
    if (this.active) return this.active
    const active = operation().finally(() => {
      if (this.active === active) this.active = null
    })
    this.active = active
    return active
  }
}

export async function waitForHealthy(opts: {
  probe: () => Promise<boolean>
  timeoutMs: number
  intervalMs?: number
  now?: () => number
  delay?: (ms: number) => Promise<void>
}): Promise<boolean> {
  const now = opts.now ?? (() => Date.now())
  const delay =
    opts.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + opts.timeoutMs

  do {
    if (await opts.probe()) return true
    if (now() >= deadline) return false
    await delay(Math.min(opts.intervalMs ?? 250, Math.max(0, deadline - now())))
  } while (now() <= deadline)

  return false
}
