import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetTabbyAuthStateForTests,
  adminAuthHeaders,
  apiAuthHeaders,
  getTabbyAuthFingerprint,
  registerTabbyAuthSecrets,
  releaseTabbyAuthSecrets,
  watchTabbyAuth
} from './auth'
import type { TabbyConfig } from '../ollama/config'
import {
  _resetSecretRegistryForTests,
  REDACTION_MARKER,
  sanitizeSecrets,
  setCredentialFailClosed
} from '../security/secret-redactor'

const dirs: string[] = []
const STABILIZE_MS = 300

function tabbyConfigWith(tokens: string | null): TabbyConfig {
  const dir = mkdtempSync(join(tmpdir(), 'tabby-auth-'))
  dirs.push(dir)
  if (tokens !== null) {
    writeFileSync(join(dir, 'api_tokens.yml'), tokens, 'utf-8')
  }
  return {
    installDir: dir,
    pythonPath: '',
    configPath: '',
    host: '127.0.0.1',
    port: 5000,
    modelDir: '',
    autoStartServe: false
  }
}

afterEach(() => {
  releaseTabbyAuthSecrets()
  _resetTabbyAuthStateForTests()
  _resetSecretRegistryForTests()
  setCredentialFailClosed(false)
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('tabby auth headers', () => {
  /**
   * TabbyAPI spouští na admin route nejdřív check_api_key — samotný x-admin-key
   * vrací 401 "Please provide an API key".
   */
  it('sends both api and admin headers for admin routes', () => {
    const cfg = tabbyConfigWith('api_key: aaa111\nadmin_key: bbb222\n')
    expect(adminAuthHeaders(cfg)).toEqual({
      'x-api-key': 'aaa111',
      'x-admin-key': 'bbb222'
    })
  })

  it('uses the admin key as api key when api_key is missing', () => {
    const cfg = tabbyConfigWith('admin_key: bbb222\n')
    expect(adminAuthHeaders(cfg)).toEqual({
      'x-api-key': 'bbb222',
      'x-admin-key': 'bbb222'
    })
  })

  it('sends only the api key for inference routes', () => {
    const cfg = tabbyConfigWith('api_key: aaa111\nadmin_key: bbb222\n')
    expect(apiAuthHeaders(cfg)).toEqual({ 'x-api-key': 'aaa111' })
  })

  it('never leaks key material in the renderer fingerprint', () => {
    const cfg = tabbyConfigWith('api_key: aaa111\nadmin_key: bbb222\n')
    const fingerprint = getTabbyAuthFingerprint(cfg)
    expect(fingerprint.hasApiKey).toBe(true)
    expect(fingerprint.hasAdminKey).toBe(true)
    expect(JSON.stringify(fingerprint)).not.toContain('aaa111')
    expect(JSON.stringify(fingerprint)).not.toContain('bbb222')
  })

  it('returns no headers when the tokens file is missing', () => {
    const cfg = tabbyConfigWith(null)
    expect(adminAuthHeaders(cfg)).toEqual({})
    expect(apiAuthHeaders(cfg)).toEqual({})
  })
})

describe('tabby auth rotation registry', () => {
  it('keeps old keys registered through missing/empty/invalid transient states', () => {
    const cfg = tabbyConfigWith('api_key: synthetic-rotate-old-key-101\n')
    const path = join(cfg.installDir, 'api_tokens.yml')
    registerTabbyAuthSecrets(cfg)
    expect(sanitizeSecrets('synthetic-rotate-old-key-101')).toContain(REDACTION_MARKER)

    unlinkSync(path)
    registerTabbyAuthSecrets(cfg)
    expect(sanitizeSecrets('synthetic-rotate-old-key-101')).toContain(REDACTION_MARKER)

    writeFileSync(path, '', 'utf8')
    registerTabbyAuthSecrets(cfg)
    expect(sanitizeSecrets('synthetic-rotate-old-key-101')).toContain(REDACTION_MARKER)

    writeFileSync(path, 'api_key: "unclosed\n', 'utf8')
    registerTabbyAuthSecrets(cfg)
    expect(sanitizeSecrets('synthetic-rotate-old-key-101')).toContain(REDACTION_MARKER)
  })

  it('registers new keys before releasing old after stable valid file', async () => {
    const cfg = tabbyConfigWith('api_key: synthetic-rotate-old-key-102\n')
    const path = join(cfg.installDir, 'api_tokens.yml')
    registerTabbyAuthSecrets(cfg)
    writeFileSync(path, 'api_key: synthetic-rotate-new-key-103\n', 'utf8')
    registerTabbyAuthSecrets(cfg)
    expect(sanitizeSecrets('synthetic-rotate-new-key-103')).toContain(REDACTION_MARKER)
    expect(sanitizeSecrets('synthetic-rotate-old-key-102')).not.toContain(REDACTION_MARKER)
    expect(sanitizeSecrets('synthetic-rotate-old-key-102')).toBe('synthetic-rotate-old-key-102')
  })

  it('watcher keeps old keys through confirmed delete until new stable file', async () => {
    const cfg = tabbyConfigWith('api_key: synthetic-rotate-old-key-104\n')
    const path = join(cfg.installDir, 'api_tokens.yml')
    registerTabbyAuthSecrets(cfg)
    const release = watchTabbyAuth(() => undefined, cfg)
    unlinkSync(path)
    registerTabbyAuthSecrets(cfg)
    expect(sanitizeSecrets('synthetic-rotate-old-key-104')).toContain(REDACTION_MARKER)
    await new Promise((r) => setTimeout(r, STABILIZE_MS + 50))
    expect(sanitizeSecrets('synthetic-rotate-old-key-104')).toContain(REDACTION_MARKER)
    writeFileSync(path, 'api_key: synthetic-rotate-new-key-105\n', 'utf8')
    registerTabbyAuthSecrets(cfg)
    expect(sanitizeSecrets('synthetic-rotate-new-key-105')).toContain(REDACTION_MARKER)
    expect(sanitizeSecrets('synthetic-rotate-old-key-104')).toBe('synthetic-rotate-old-key-104')
    release()
  })
})
