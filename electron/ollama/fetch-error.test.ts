import { afterEach, describe, expect, it } from 'vitest'
import {
  ErrorLogDeduper,
  classifyNetworkCode,
  extractCauseChain,
  formatFetchErrorUserText,
  inspectFetchError,
  isBackendLostError,
  NetworkError,
  shouldSkipBackendPoll,
  shouldSwallowPollError,
  stripUrlSecrets
} from './fetch-error'
import { isAppQuitting, markAppQuitting, resetAppQuittingForTests } from './app-lifecycle'
import { logIpcError } from './ipc-error'
import { logBuffer } from './log-buffer'

function t(key: string, vars?: Record<string, string | number>): string {
  const extra = vars
    ? Object.entries(vars)
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
    : ''
  return extra ? `${key}(${extra})` : key
}

function undiciFetchFailed(cause: Error & { code?: string; address?: string; port?: number }): TypeError {
  const err = new TypeError('fetch failed')
  Object.defineProperty(err, 'cause', { value: cause })
  return err
}

afterEach(() => {
  resetAppQuittingForTests()
})

describe('extractCauseChain', () => {
  it('walks nested cause including Node connect errors', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5000'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 5000
    })
    const err = undiciFetchFailed(cause)
    const chain = extractCauseChain(err)
    expect(chain.map((l) => l.message)).toEqual([
      'fetch failed',
      'connect ECONNREFUSED 127.0.0.1:5000'
    ])
    expect(chain[1]?.code).toBe('ECONNREFUSED')
    expect(chain[1]?.address).toBe('127.0.0.1')
    expect(chain[1]?.port).toBe(5000)
  })
})

describe('classifyNetworkCode / user text', () => {
  it('maps ECONNREFUSED to a human message without the syscall code', () => {
    expect(classifyNetworkCode('ECONNREFUSED')).toBe('connRefused')
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5000'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 5000
    })
    const info = inspectFetchError(new NetworkError('http://127.0.0.1:5000/v1/model/list', cause))
    expect(info.kind).toBe('connRefused')
    expect(info.target).toBe('127.0.0.1:5000')
    expect(info.url).toBe('http://127.0.0.1:5000/v1/model/list')
    expect(info.logLine).toContain('127.0.0.1:5000')
    expect(info.logLine.toLowerCase()).not.toBe('fetch failed')
    const user = formatFetchErrorUserText(info, t)
    expect(user).toBe('errors.connRefused(target=127.0.0.1:5000)')
    expect(user.toLowerCase()).not.toContain('econnrefused')
    expect(user.toLowerCase()).not.toContain('fetch failed')
  })

  it('maps timeout, reset, DNS and abort', () => {
    expect(classifyNetworkCode('ETIMEDOUT')).toBe('timedOut')
    expect(classifyNetworkCode('UND_ERR_CONNECT_TIMEOUT')).toBe('timedOut')
    expect(classifyNetworkCode('ECONNRESET')).toBe('connReset')
    expect(classifyNetworkCode('ENOTFOUND')).toBe('dnsFailed')
    expect(classifyNetworkCode('ABORT_ERR', 'AbortError')).toBe('aborted')
    expect(classifyNetworkCode(null, undefined, 'HTTP 503 from upstream')).toBe('http')
  })

  it('never returns a bare fetch failed for a generic TypeError', () => {
    const info = inspectFetchError(new TypeError('fetch failed'))
    expect(info.logLine.toLowerCase()).not.toBe('fetch failed')
    const user = formatFetchErrorUserText(info, t)
    expect(user.toLowerCase()).not.toBe('fetch failed')
    expect(user).toContain('errors.networkFailed')
  })
})

describe('stripUrlSecrets', () => {
  it('redacts query tokens, basic auth and hf_ tokens', () => {
    expect(
      stripUrlSecrets('https://huggingface.co/api/models/x?token=hf_secret_value&revision=main')
    ).not.toContain('hf_secret_value')
    expect(stripUrlSecrets('https://huggingface.co/api/models/x?token=hf_secret_value')).toContain(
      'token=***'
    )
    expect(stripUrlSecrets('http://user:s3cret@127.0.0.1:5000/v1/model')).not.toContain('s3cret')
    expect(stripUrlSecrets('http://127.0.0.1:5000/v1/download?api_key=abc123')).toContain('***')
    expect(stripUrlSecrets('http://127.0.0.1:5000/v1/download?api_key=abc123')).not.toContain(
      'abc123'
    )
  })

  it('does not leak secrets into inspectFetchError output', () => {
    const info = inspectFetchError(
      new NetworkError('https://huggingface.co/api/models/x?token=hf_secret_value', new Error('boom'))
    )
    expect(JSON.stringify(info)).not.toContain('hf_secret_value')
    expect(formatFetchErrorUserText(info, t)).not.toContain('hf_secret_value')
  })
})

describe('ErrorLogDeduper', () => {
  it('logs the first hit and suppresses duplicates inside the window with a count', () => {
    let now = 1_000
    const deduper = new ErrorLogDeduper(30_000, () => now)
    expect(deduper.record('k')).toEqual({ shouldLog: true, suppressedCount: 0 })
    expect(deduper.record('k')).toEqual({ shouldLog: false, suppressedCount: 1 })
    expect(deduper.record('k')).toEqual({ shouldLog: false, suppressedCount: 2 })
    now = 31_500
    expect(deduper.record('k')).toEqual({ shouldLog: true, suppressedCount: 2 })
  })
})

describe('shutdown / serve-not-running polls', () => {
  it('skips catalog polls while quitting or when serve is not running', () => {
    expect(shouldSkipBackendPoll(true, 'running')).toBe(true)
    expect(shouldSkipBackendPoll(false, 'stopping')).toBe(true)
    expect(shouldSkipBackendPoll(false, 'stopped')).toBe(true)
    expect(shouldSkipBackendPoll(false, 'starting')).toBe(true)
    expect(shouldSkipBackendPoll(false, 'error')).toBe(true)
    expect(shouldSkipBackendPoll(false, 'running')).toBe(false)
    expect(shouldSwallowPollError(true, 'running')).toBe(true)
  })

  it('exposes the process-wide quitting flag', () => {
    expect(isAppQuitting()).toBe(false)
    markAppQuitting()
    expect(isAppQuitting()).toBe(true)
  })

  it('does not write poll failures to the log buffer while quitting', () => {
    markAppQuitting()
    const before = logBuffer.getEntries().length
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5000'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 5000
    })
    logIpcError('get-models-tags', new NetworkError('http://127.0.0.1:5000/v1/model/list', cause))
    expect(logBuffer.getEntries().length).toBe(before)
  })
})

describe('isBackendLostError', () => {
  it('treats ECONNREFUSED / ECONNRESET as a vanished backend', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5000'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 5000
    })
    expect(isBackendLostError(new NetworkError('http://127.0.0.1:5000/v1/download', refused))).toBe(
      true
    )
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    expect(isBackendLostError(reset)).toBe(true)
    expect(isBackendLostError(new Error('HTTP 401: Please provide an API key'))).toBe(false)
  })
})
