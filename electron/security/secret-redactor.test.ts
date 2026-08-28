import { describe, expect, it, afterEach } from 'vitest'
import {
  _resetSecretRegistryForTests,
  REDACTION_MARKER,
  registerSecret,
  registerSecrets,
  sanitizeSecrets,
  sanitizeTabbyKeyLine,
  sanitizeUrl
} from './secret-redactor'

afterEach(() => {
  _resetSecretRegistryForTests()
})

describe('secret-redactor', () => {
  it('redacts registered secrets longest-first and is idempotent', () => {
    registerSecrets(['short', 'short-extended-value'])
    const once = sanitizeSecrets('short-extended-value and short')
    expect(once).not.toContain('short-extended-value')
    expect(sanitizeSecrets(once)).toBe(once)
  })

  it('ref-counts registry entries', () => {
    const releaseA = registerSecret('synthetic-api-key-aaa')
    const releaseB = registerSecret('synthetic-api-key-aaa')
    releaseA()
    expect(sanitizeSecrets('synthetic-api-key-aaa')).toContain(REDACTION_MARKER)
    releaseB()
    expect(sanitizeSecrets('synthetic-api-key-aaa')).toBe('synthetic-api-key-aaa')
  })

  it('redacts Bearer, JWT, hf_ and query params', () => {
    expect(sanitizeSecrets('Authorization: Bearer synthetic.jwt.token')).not.toContain(
      'synthetic.jwt.token'
    )
    expect(
      sanitizeSecrets(
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature-part-extra'
      )
    ).toContain(REDACTION_MARKER)
    expect(sanitizeSecrets('token=hf_synthetic_test_value')).not.toContain('hf_synthetic_test_value')
    expect(sanitizeSecrets('?api_key=synthetic-key')).not.toContain('synthetic-key')
  })

  it('preserves sha256 digests and model ids', () => {
    const digest = 'a'.repeat(64)
    const shaLine = `blob sha256:${digest}`
    expect(sanitizeSecrets(shaLine)).toBe(shaLine)
    expect(sanitizeSecrets('model deadbeef01 loaded')).toContain('deadbeef01')
  })

  it('sanitizes Tabby key lines on same row', () => {
    const line = sanitizeTabbyKeyLine('Your API key is: synthetic-tabby-key-001')
    expect(line).toContain(REDACTION_MARKER)
    expect(line).not.toContain('synthetic-tabby-key-001')
  })

  it('percentKey — decodes percent-encoded query keys and values without leaking', () => {
    const secret = 'synthetic-percent-boundary-010'
    registerSecret(secret)
    const encodedKey = encodeURIComponent('api_key')
    const encodedValue = encodeURIComponent(secret)
    const url = `https://example.test/v1?${encodedKey}=${encodedValue}&model=deadbeef01`
    const out = sanitizeUrl(url)
    expect(out).not.toContain(secret)
    expect(out).not.toContain(encodedValue)
    expect(out).toContain('deadbeef01')
  })

  it('yamlSingleQuoted — redacts YAML with single-quoted key and value', () => {
    const secret = 'synthetic-yaml-single-011'
    registerSecret(secret)
    const raw = `'api_key': '${secret}'`
    const out = sanitizeSecrets(raw)
    expect(out).not.toContain(secret)
    expect(out).toContain("'api_key': '***'")
  })

  it('ansiAfterLabel — redacts value after ANSI reset and timestamp on same line', () => {
    const secret = 'synthetic-ansi-label-012'
    registerSecret(secret)
    const raw = `Your API key is:\x1b[0m2026-01-01 ${secret}`
    const out = sanitizeTabbyKeyLine(raw)
    expect(out).not.toContain(secret)
    expect(out).toContain(REDACTION_MARKER)
  })

  it('percentKey — redacts when credential query is split across sanitizeUrl chunks', () => {
    const secret = 'synthetic-percent-chunk-013'
    registerSecret(secret)
    const encoded = encodeURIComponent(secret)
    const parts = [`https://example.test/v1?api%5Fkey=${encoded.slice(0, 8)}`, encoded.slice(8)]
    let out = ''
    for (const part of parts) out = sanitizeUrl(out + part)
    expect(out).not.toContain(secret)
    expect(out).not.toContain(encoded)
  })
})
