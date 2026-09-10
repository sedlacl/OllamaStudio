import { describe, expect, it } from 'vitest'
import { assembleTabbyLogLine, parseTabbyLogLine } from './log-parser'
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

  it('parses the streaming request variants', () => {
    expect(
      parseTabbyLogLine('Received chat completion streaming request abcdef123456').requestId
    ).toBe('abcdef123456')
    const finished = parseTabbyLogLine(
      'Finished chat completion streaming request abcdef123456'
    )
    expect(finished.isComplete).toBe(true)
    expect(finished.requestId).toBe('abcdef123456')
  })

  it('parses the full metrics itemization', () => {
    const event = parseTabbyLogLine(
      'Metrics (ID: adfaef2a139c4fc3979731b09b95f512): 76 tokens generated in 3.91 ' +
        'seconds (Queue: 0.03 s, Process: 12288 cached tokens and 405 new tokens at ' +
        '358.41 T/s, Generate: 19.42 T/s, Context: 12693 tokens)'
    )
    expect(event.generationTokens).toBe(76)
    expect(event.elapsedSeconds).toBe(3.91)
    expect(event.queueSeconds).toBe(0.03)
    expect(event.cachedTokens).toBe(12288)
    expect(event.promptTokens).toBe(12693)
    expect(event.promptTokensPerSec).toBe(358.41)
    expect(event.generationTokensPerSec).toBe(19.42)
    expect(event.contextTokens).toBe(12693)
  })

  it('detects load/unload', () => {
    expect(parseTabbyLogLine('Loading model: foo').isLoad).toBe(true)
    expect(parseTabbyLogLine('Unloading model').isUnload).toBe(true)
  })
})

describe('assembleTabbyLogLine', () => {
  const lines = [
    '2026-09-10 20:23:08.715 INFO:     Metrics (ID: ',
    'adfaef2a139c4fc3979731b09b95f512): 76 tokens generated in 3.91 seconds (Queue: ',
    '0.03 s, Process: 12288 cached tokens and 405 new tokens at 358.41 T/s, Generate: ',
    '19.42 T/s, Context: 12693 tokens)'
  ]

  it('rejoins a line wrapped by the Rich console', () => {
    let pending = ''
    const events = lines.map((line) => {
      pending = assembleTabbyLogLine(pending, line)
      return parseTabbyLogLine(line, pending)
    })
    const last = events[events.length - 1]!
    expect(last.requestId).toBe('adfaef2a139c4fc3979731b09b95f512')
    expect(last.generationTokens).toBe(76)
    expect(last.promptTokensPerSec).toBe(358.41)
    expect(last.generationTokensPerSec).toBe(19.42)
    // Fragment se samotným id ještě metriku netvoří.
    expect(events[0]!.requestId).toBeUndefined()
  })

  it('starts over on a timestamped line and keeps bare uvicorn lines separate', () => {
    let pending = assembleTabbyLogLine('', lines[0])
    pending = assembleTabbyLogLine(pending, 'INFO:     127.0.0.1:51054 - "GET /health HTTP/1.1" 200')
    expect(pending.startsWith('INFO:')).toBe(true)
    expect(parseTabbyLogLine('INFO:     127.0.0.1:51054 - "GET /health HTTP/1.1" 200', pending)
      .isRequest).toBeUndefined()
  })

  it('classifies errors from the physical line, not the assembled text', () => {
    const pending = assembleTabbyLogLine('', '2026-09-10 20:10:16.000 ERROR:    boom ')
    const continuation = parseTabbyLogLine('  more detail', assembleTabbyLogLine(pending, '  more detail'))
    expect(continuation.isError).toBe(false)
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

  it('fills history speed from a wrapped metrics line', () => {
    const buf = new LogBuffer({ now: () => 1_000 })
    buf.setVendor('tabby')
    buf.append(
      'stdout',
      [
        '2026-09-10 20:23:04.802 INFO:     Received chat completion streaming request ',
        'adfaef2a139c4fc3979731b09b95f512',
        '2026-09-10 20:23:08.715 INFO:     Metrics (ID: ',
        'adfaef2a139c4fc3979731b09b95f512): 76 tokens generated in 3.91 seconds (Queue: ',
        '0.03 s, Process: 12288 cached tokens and 405 new tokens at 358.41 T/s, Generate: ',
        '19.42 T/s, Context: 12693 tokens)',
        ''
      ].join('\n')
    )
    const [item] = buf.getRequestHistory()
    expect(item?.result).toBe('done')
    expect(item?.generationTokens).toBe(76)
    expect(item?.promptTokens).toBe(12693)
    expect(item?.elapsedSeconds).toBe(3.91)
    expect(item?.generationTokensPerSec).toBe(19.42)
    expect(item?.promptTokensPerSec).toBe(358.41)
  })
})
