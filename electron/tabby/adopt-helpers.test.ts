import { describe, expect, it } from 'vitest'
import {
  PID_CREATION_TOLERANCE_MS,
  classifyListenerProbe,
  commandLineLooksLikeTabby,
  decideTabbyStart,
  isTabbyHealthBody,
  isTabbyModelEndpoint,
  parseOwnedPidRecord,
  validateStoredPid,
  type LiveProcessInfo,
  type StoredOwnedPid
} from './adopt-helpers'

const stored: StoredOwnedPid = {
  pid: 4242,
  host: '127.0.0.1',
  port: 5000,
  pythonPath: 'D:\\AI\\Tabby\\venv\\Scripts\\python.exe',
  installDir: 'D:\\AI\\Tabby',
  startedAtMs: 1_700_000_000_000
}

const current = {
  host: '127.0.0.1',
  port: 5000,
  installDir: 'D:\\AI\\Tabby',
  pythonPath: 'D:\\AI\\Tabby\\venv\\Scripts\\python.exe'
}

const liveTabby: LiveProcessInfo = {
  pid: 4242,
  alive: true,
  commandLine: '"D:\\AI\\Tabby\\venv\\Scripts\\python.exe" D:\\AI\\Tabby\\main.py',
  creationTimeMs: 1_700_000_000_400
}

function probe(partial: Partial<Parameters<typeof classifyListenerProbe>[0]>) {
  return classifyListenerProbe({
    portBusy: false,
    healthReached: false,
    healthHttpStatus: null,
    healthJson: null,
    modelReached: false,
    modelHttpStatus: null,
    modelJson: null,
    ...partial
  })
}

describe('isTabbyHealthBody', () => {
  it('accepts Tabby health schema', () => {
    expect(isTabbyHealthBody({ status: 'healthy', issues: [] })).toBe(true)
    expect(isTabbyHealthBody({ status: 'unhealthy', issues: ['gpu'] })).toBe(true)
  })

  it('rejects generic health payloads', () => {
    expect(isTabbyHealthBody({ status: 'ok' })).toBe(false)
    expect(isTabbyHealthBody({ status: 'healthy' })).toBe(false)
    expect(isTabbyHealthBody({ issues: [] })).toBe(false)
    expect(isTabbyHealthBody('<html>ok</html>')).toBe(false)
    expect(isTabbyHealthBody(null)).toBe(false)
    expect(isTabbyHealthBody([{ status: 'healthy', issues: [] }])).toBe(false)
  })
})

describe('isTabbyModelEndpoint', () => {
  it('accepts loaded model payload', () => {
    expect(isTabbyModelEndpoint(200, { id: 'exl3-model', parameters: {} })).toBe(true)
    expect(isTabbyModelEndpoint(200, { id: null, parameters: { max_seq_len: 1 } })).toBe(true)
  })

  it('accepts Tabby empty-model errors without reading message text', () => {
    expect(isTabbyModelEndpoint(503, { error: { message: 'No model loaded.' } })).toBe(true)
    expect(isTabbyModelEndpoint(400, { error: 'no model' })).toBe(true)
  })

  it('does not treat a generic 401 or HTML as Tabby', () => {
    expect(isTabbyModelEndpoint(401, { detail: 'Unauthorized' })).toBe(false)
    expect(isTabbyModelEndpoint(200, { data: [] })).toBe(false)
    expect(isTabbyModelEndpoint(200, '<html/>')).toBe(false)
    expect(isTabbyModelEndpoint(null, { id: 'x' })).toBe(false)
  })
})

describe('classifyListenerProbe', () => {
  it('returns empty when nothing listens', () => {
    expect(probe({})).toBe('empty')
  })

  it('returns tabby for a health schema hit even without /v1/model', () => {
    expect(
      probe({
        portBusy: true,
        healthReached: true,
        healthHttpStatus: 200,
        healthJson: { status: 'healthy', issues: [] }
      })
    ).toBe('tabby')
  })

  it('returns tabby for /v1/model when health is down', () => {
    expect(
      probe({
        portBusy: true,
        modelReached: true,
        modelHttpStatus: 200,
        modelJson: { id: 'm' }
      })
    ).toBe('tabby')
  })

  it('returns foreign for an occupied port that is not Tabby', () => {
    expect(
      probe({
        portBusy: true,
        healthReached: true,
        healthHttpStatus: 200,
        healthJson: { status: 'ok' }
      })
    ).toBe('foreign')
  })

  it('returns foreign for TCP-busy with no HTTP', () => {
    expect(probe({ portBusy: true })).toBe('foreign')
  })

  it('returns foreign for HTML on the port', () => {
    expect(
      probe({
        portBusy: true,
        healthReached: true,
        healthHttpStatus: 200,
        healthJson: null
      })
    ).toBe('foreign')
  })
})

describe('decideTabbyStart', () => {
  it('spawns when the port is free', () => {
    expect(decideTabbyStart({ listener: 'empty', pidCheck: 'missing' })).toBe('spawn')
    expect(decideTabbyStart({ listener: 'empty', pidCheck: 'match' })).toBe('spawn')
    expect(decideTabbyStart({ listener: 'empty', pidCheck: 'stale' })).toBe('spawn')
  })

  it('adopts only a verified orphan Tabby', () => {
    expect(decideTabbyStart({ listener: 'tabby', pidCheck: 'match' })).toBe('adopt')
  })

  it('attaches as external when Tabby is running but PID is not ours', () => {
    expect(decideTabbyStart({ listener: 'tabby', pidCheck: 'missing' })).toBe('attach-external')
    expect(decideTabbyStart({ listener: 'tabby', pidCheck: 'stale' })).toBe('attach-external')
    expect(decideTabbyStart({ listener: 'tabby', pidCheck: 'mismatch' })).toBe('attach-external')
  })

  it('conflicts on a foreign listener and never adopts or spawns', () => {
    expect(decideTabbyStart({ listener: 'foreign', pidCheck: 'missing' })).toBe('conflict')
    expect(decideTabbyStart({ listener: 'foreign', pidCheck: 'match' })).toBe('conflict')
    expect(decideTabbyStart({ listener: 'foreign', pidCheck: 'stale' })).toBe('conflict')
  })
})

describe('commandLineLooksLikeTabby', () => {
  it('requires main.py and install dir or python path', () => {
    expect(
      commandLineLooksLikeTabby(
        '"D:\\AI\\Tabby\\venv\\Scripts\\python.exe" D:\\AI\\Tabby\\main.py',
        'D:\\AI\\Tabby',
        'D:\\AI\\Tabby\\venv\\Scripts\\python.exe'
      )
    ).toBe(true)
    expect(
      commandLineLooksLikeTabby(
        'D:/AI/Tabby/venv/Scripts/python.exe D:/AI/Tabby/main.py',
        'D:\\AI\\Tabby',
        ''
      )
    ).toBe(true)
    expect(commandLineLooksLikeTabby('python.exe other.py', 'D:\\AI\\Tabby', '')).toBe(false)
    expect(commandLineLooksLikeTabby(null, 'D:\\AI\\Tabby', 'python.exe')).toBe(false)
    expect(
      commandLineLooksLikeTabby(
        'notepad.exe',
        'D:\\AI\\Tabby',
        'D:\\AI\\Tabby\\venv\\Scripts\\python.exe'
      )
    ).toBe(false)
  })
})

describe('validateStoredPid', () => {
  it('returns missing when nothing was stored', () => {
    expect(validateStoredPid(null, liveTabby, current)).toBe('missing')
  })

  it('returns stale when the PID is gone', () => {
    expect(validateStoredPid(stored, null, current)).toBe('stale')
    expect(
      validateStoredPid(stored, { ...liveTabby, alive: false, commandLine: null }, current)
    ).toBe('stale')
  })

  it('matches a live Tabby with the same creation time', () => {
    expect(validateStoredPid(stored, liveTabby, current)).toBe('match')
  })

  it('rejects PID reuse by a different process', () => {
    expect(
      validateStoredPid(
        stored,
        { ...liveTabby, commandLine: 'C:\\Windows\\notepad.exe' },
        current
      )
    ).toBe('mismatch')
  })

  it('rejects recycled PID that happens to run Tabby later', () => {
    expect(
      validateStoredPid(
        stored,
        {
          ...liveTabby,
          creationTimeMs: stored.startedAtMs + PID_CREATION_TOLERANCE_MS + 1
        },
        current
      )
    ).toBe('mismatch')
  })

  it('rejects host/port mismatch so a moved endpoint is not adopted', () => {
    expect(validateStoredPid(stored, liveTabby, { ...current, port: 5001 })).toBe('mismatch')
    expect(validateStoredPid(stored, liveTabby, { ...current, host: '0.0.0.0' })).toBe('mismatch')
  })

  it('does not trust a live PID without a command line', () => {
    expect(validateStoredPid(stored, { ...liveTabby, commandLine: null }, current)).toBe(
      'mismatch'
    )
  })
})

describe('parseOwnedPidRecord', () => {
  it('parses a valid record and ignores unknown fields', () => {
    expect(parseOwnedPidRecord({ ...stored, extra: true })).toEqual(stored)
  })

  it('rejects invalid pid, port, host, or timestamp', () => {
    expect(parseOwnedPidRecord({ ...stored, pid: 0 })).toBeNull()
    expect(parseOwnedPidRecord({ ...stored, pid: 1.5 })).toBeNull()
    expect(parseOwnedPidRecord({ ...stored, port: 70000 })).toBeNull()
    expect(parseOwnedPidRecord({ ...stored, host: '  ' })).toBeNull()
    expect(parseOwnedPidRecord({ ...stored, installDir: '' })).toBeNull()
    expect(parseOwnedPidRecord({ ...stored, startedAtMs: -1 })).toBeNull()
    expect(parseOwnedPidRecord({ ...stored, pythonPath: 1 })).toBeNull()
    expect(parseOwnedPidRecord('4242')).toBeNull()
    expect(parseOwnedPidRecord(null)).toBeNull()
  })

  it('keeps an optional runtime patch marker for safe adoption', () => {
    expect(
      parseOwnedPidRecord({
        ...stored,
        runtimePatchVersion: 'ollamastudio-1.4.1-v1'
      })?.runtimePatchVersion
    ).toBe('ollamastudio-1.4.1-v1')
  })
})
