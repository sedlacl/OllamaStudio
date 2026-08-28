import { describe, expect, it, afterEach } from 'vitest'
import { LogBuffer } from './log-buffer'
import {
  _resetSecretRegistryForTests,
  REDACTION_MARKER,
  registerSecret
} from '../security/secret-redactor'

const SYNTH_API = 'synthetic-stream-api-key-001'
const SYNTH_ADMIN = 'synthetic-stream-admin-key-002'

function feedChars(buf: LogBuffer, stream: 'stdout' | 'stderr', text: string): void {
  for (const ch of text) buf.appendChunk(stream, ch)
  buf.appendChunk(stream, '\n')
}

afterEach(() => {
  _resetSecretRegistryForTests()
})

describe('LogBuffer streaming redaction', () => {
  it('redacts label/value split across chunks and streams', () => {
    registerSecret(SYNTH_API)
    registerSecret(SYNTH_ADMIN)
    const buf = new LogBuffer({ now: () => 1_000 })
    buf.setVendor('tabby')

    feedChars(buf, 'stdout', 'Your API key is:')
    feedChars(buf, 'stdout', SYNTH_API)
    feedChars(buf, 'stderr', `Your admin key is: ${SYNTH_ADMIN}`)

    const text = buf.getEntries().map((e) => e.text).join('\n')
    expect(text).not.toContain(SYNTH_API)
    expect(text).not.toContain(SYNTH_ADMIN)
    expect(text).toContain(REDACTION_MARKER)
  })

  it('does not emit incomplete line before flush', () => {
    const buf = new LogBuffer()
    buf.appendChunk('stdout', 'partial without newline')
    expect(buf.getEntries()).toHaveLength(0)
    buf.flushAll()
    expect(buf.getEntries()).toHaveLength(0)
  })

  it('fail-closes oversized lines without leaking payload', () => {
    const buf = new LogBuffer()
    const payload = `x${'y'.repeat(70_000)}`
    registerSecret('y')
    buf.appendChunk('stdout', payload)
    const entry = buf.getEntries().at(-1)
    expect(entry?.text).toContain('oversized line')
    expect(entry?.text).not.toContain('yyyy')
  })

  it('fail-closes oversized line with newline in same chunk', () => {
    const buf = new LogBuffer()
    const leak = 'synthetic-oversized-tail-leak-015'
    registerSecret(leak)
    const payload = `${'a'.repeat(70_000)}${leak}`
    buf.appendChunk('stdout', `${payload}\n`)
    const texts = buf.getEntries().map((e) => e.text)
    expect(texts.some((t) => t.includes('oversized line'))).toBe(true)
    expect(texts.join('\n')).not.toContain(leak)
    expect(texts.join('\n')).not.toMatch(/a{100}/)
  })

  it('discards trailing payload across chunks until newline after oversized line', () => {
    const buf = new LogBuffer()
    registerSecret('leak-chunk-secret-014')
    const head = 'a'.repeat(40_000)
    buf.appendChunk('stdout', head)
    expect(buf.getEntries()).toHaveLength(0)
    buf.appendChunk('stdout', `${'b'.repeat(40_000)}leak-chunk-secret-014`)
    expect(buf.getEntries().some((e) => e.text.includes('oversized line'))).toBe(true)
    buf.appendChunk('stdout', 'still-leaked-without-newline')
    expect(buf.getEntries().some((e) => e.text.includes('still-leaked'))).toBe(false)
    buf.appendChunk('stdout', '\n')
    buf.appendChunk('stdout', 'safe-after-newline\n')
    const joined = buf.getEntries().map((e) => e.text).join('\n')
    expect(joined).not.toContain('leak-chunk-secret-014')
    expect(joined).not.toContain('still-leaked')
    expect(joined).toContain('safe-after-newline')
  })

  it('resanitizes RAM when a secret is registered later', () => {
    const buf = new LogBuffer()
    buf.appendApp('error', 'leaked synthetic-late-key-003 in app log')
    registerSecret('synthetic-late-key-003')
    expect(buf.getEntries()[0]?.text).not.toContain('synthetic-late-key-003')
  })

  it('clears carry state on vendor switch', () => {
    const buf = new LogBuffer()
    buf.appendChunk('stdout', 'Your API key is:')
    buf.setVendor('tabby')
    registerSecret(SYNTH_API)
    feedChars(buf, 'stdout', SYNTH_API)
    const joined = buf.getEntries().map((e) => e.text).join(' ')
    expect(joined).not.toContain(SYNTH_API)
  })
})
