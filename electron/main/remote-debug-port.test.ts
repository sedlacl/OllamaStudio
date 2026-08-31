import { describe, expect, it } from 'vitest'
import {
  REMOTE_DEBUG_ENV,
  isRemoteDebugAllowed,
  parseRemoteDebugPort,
  resolveRemoteDebugPort
} from './remote-debug-port'

describe('remote debug port (dev-only gate)', () => {
  it('accepts valid high ports and rejects invalid values', () => {
    expect(parseRemoteDebugPort('9344')).toBe(9344)
    expect(parseRemoteDebugPort('65535')).toBe(65535)
    expect(parseRemoteDebugPort('1024')).toBe(1024)
    expect(parseRemoteDebugPort('80')).toBeNull()
    expect(parseRemoteDebugPort('70000')).toBeNull()
    expect(parseRemoteDebugPort('abc')).toBeNull()
    expect(parseRemoteDebugPort('')).toBeNull()
    expect(parseRemoteDebugPort(undefined)).toBeNull()
  })

  it('allows remote debug only in development unpackaged builds', () => {
    expect(isRemoteDebugAllowed('development', false)).toBe(true)
    expect(isRemoteDebugAllowed('production', false)).toBe(false)
    expect(isRemoteDebugAllowed('development', true)).toBe(false)
    expect(isRemoteDebugAllowed(undefined, false)).toBe(false)
  })

  it('resolves port from env only when dev gate passes', () => {
    const env = { NODE_ENV: 'development', [REMOTE_DEBUG_ENV]: '9344' }
    expect(resolveRemoteDebugPort(env, false)).toBe(9344)
    expect(resolveRemoteDebugPort(env, true)).toBeNull()
    expect(
      resolveRemoteDebugPort({ NODE_ENV: 'production', [REMOTE_DEBUG_ENV]: '9344' }, false)
    ).toBeNull()
    expect(
      resolveRemoteDebugPort({ NODE_ENV: 'development', [REMOTE_DEBUG_ENV]: 'bad' }, false)
    ).toBeNull()
  })
})
