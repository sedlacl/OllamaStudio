import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { adminAuthHeaders, apiAuthHeaders, getTabbyAuthFingerprint } from './auth'
import type { TabbyConfig } from '../ollama/config'

const dirs: string[] = []

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
