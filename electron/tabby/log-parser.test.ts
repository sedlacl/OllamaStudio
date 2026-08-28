import { describe, expect, it } from 'vitest'
import { parseTabbyLogLine } from './log-parser'
import { LogBuffer } from '../ollama/log-buffer'
import { capabilitiesFor } from '../backends/types'

describe('capabilities', () => {
  it('marks Tabby without Ollama clone/delete/keepAlive', () => {
    const caps = capabilitiesFor('tabby')
    expect(caps.hfDownload).toBe(true)
    expect(caps.mtp).toBe(true)
    expect(caps.cloneModel).toBe(false)
    expect(caps.deleteModel).toBe(false)
    expect(caps.keepAlive).toBe(false)
    expect(caps.speedTestAutoAfterLoad).toBe(false)
    expect(caps.continueIntegration).toBe(false)
  })

  it('keeps Ollama pull capabilities', () => {
    const caps = capabilitiesFor('ollama')
    expect(caps.pullLibraryTag).toBe(true)
    expect(caps.hfDownload).toBe(false)
  })
})

describe('parseTabbyLogLine', () => {
  it('parses Received / Finished / Metrics', () => {
    const received = parseTabbyLogLine(
      'Received chat completion request abcdef123456'
    )
    expect(received.isRequest).toBe(true)
    expect(received.requestId).toBe('abcdef123456')

    const finished = parseTabbyLogLine(
      'Finished chat completion request abcdef123456'
    )
    expect(finished.isComplete).toBe(true)

    const metrics = parseTabbyLogLine(
      'Metrics (ID: abcdef123456): 42 tokens generated in 2.5 seconds, Generate: 16.8 T/s'
    )
    expect(metrics.generationTokens).toBe(42)
    expect(metrics.generationTokensPerSec).toBe(16.8)
    expect(metrics.requestId).toBe('abcdef123456')
  })

  it('detects load/unload', () => {
    expect(parseTabbyLogLine('Loading model: foo').isLoad).toBe(true)
    expect(parseTabbyLogLine('Unloading model').isUnload).toBe(true)
  })
})

describe('LogBuffer appendApp', () => {
  it('records an error without inventing Tabby request metrics', () => {
    const buf = new LogBuffer({ now: () => 2_000 })
    buf.setVendor('tabby')
    buf.appendApp(
      'error',
      '[studio] get-models-tags: http://127.0.0.1:5000/v1/model/list — connect ECONNREFUSED 127.0.0.1:5000'
    )
    const entries = buf.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.level).toBe('error')
    expect(entries[0]?.category).toBe('error')
    expect(entries[0]?.text).toContain('ECONNREFUSED')
    expect(buf.getActiveRequests()).toEqual([])
  })

  it('setVendor still clears app-originated lines', () => {
    const buf = new LogBuffer({ now: () => 3_000 })
    buf.appendApp('error', '[studio] leftover')
    buf.setVendor('tabby')
    expect(buf.getEntries()).toEqual([])
  })
})

describe('LogBuffer tabby vendor', () => {
  it('tracks requests by Tabby request id and rolls TPS', () => {
    const buf = new LogBuffer({ now: () => 1_000 })
    buf.setVendor('tabby')
    buf.append(
      'stdout',
      'Received chat completion request deadbeef01\n'
    )
    buf.append(
      'stdout',
      'Metrics (ID: deadbeef01): 10 tokens generated in 1.0 seconds, Generate: 10.0 T/s\n'
    )
    const active = buf.getActiveRequests()
    expect(active.some((r) => r.status === 'completed' || r.status === 'active')).toBe(
      true
    )
    expect(buf.getRollingTokensPerSec()).toBe(10)
  })
})
