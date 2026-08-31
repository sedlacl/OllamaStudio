import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetSecretRegistryForTests,
  REDACTION_MARKER,
  registerSecret,
  registerSecrets,
  sanitizeSecrets,
  sanitizeUrl,
  setCredentialFailClosed
} from './secret-redactor'
import {
  createStatefulScrubState,
  scrubLogLineStateful,
  scrubLogFileAtomic
} from './log-scrub'
import { LogBuffer } from '../ollama/log-buffer'
import {
  registerTabbyAuthSecrets,
  releaseTabbyAuthSecrets,
  watchTabbyAuth
} from '../tabby/auth'
import { snapshotContainsSecrets } from '../tabby/download-session-helpers'
import {
  sanitizeKillProcessResult,
  sanitizePathForState,
  sanitizePullProgress,
  sanitizeSpeedTestResult,
  sanitizeUpdateInfo
} from './sanitize-state'
import {
  clearAllSpeedTests,
  getSpeedTests,
  recordSpeedTest
} from '../ollama/speed-test-registry'
import {
  beginOwnedDownload,
  getDownloadStatusSnapshot,
  recordDownloadConflict,
  rememberDownloadForm,
  resetDownloadSessionForTests
} from '../tabby/download-session'

const SYN_JSON = 'synthetic-json-quoted-secret-001'
const SYN_YAML = 'synthetic-yaml-quoted-secret-002'
const SYN_PERCENT = 'synthetic-percent-key-003'
const SYN_CROSS = 'synthetic-cross-stream-secret-004'
const SYN_CHAR = 'synthetic-char-leak-secret-005'

afterEach(() => {
  _resetSecretRegistryForTests()
  releaseTabbyAuthSecrets()
  resetDownloadSessionForTests()
})

describe('adversarial secret-redactor review cases', () => {
  it('jsonQuoted — redacts quoted JSON credential values', () => {
    registerSecret(SYN_JSON)
    const raw = `{"token":"${SYN_JSON}","model":"deadbeef01"}`
    const out = sanitizeSecrets(raw)
    expect(out).not.toContain(SYN_JSON)
    expect(out).toContain('deadbeef01')
  })

  it('yamlQuoted — redacts YAML quoted credentials', () => {
    registerSecret(SYN_YAML)
    const raw = `api_key: "${SYN_YAML}"`
    const out = sanitizeSecrets(raw)
    expect(out).not.toContain(SYN_YAML)
  })

  it('percentKey — decodes percent-encoded query keys/values before redaction', () => {
    registerSecret(SYN_PERCENT)
    const encoded = encodeURIComponent(SYN_PERCENT)
    const url = `https://example.test/v1?api%5Fkey=${encoded}`
    const out = sanitizeUrl(url)
    expect(out).not.toContain(SYN_PERCENT)
    expect(out).not.toContain(encoded)
  })

  it('preserves sha256 digests and model ids', () => {
    const digest = 'a'.repeat(64)
    expect(sanitizeSecrets(`blob sha256:${digest}`)).toContain(digest)
    expect(sanitizeSecrets('model deadbeef01 loaded')).toContain('deadbeef01')
  })
})

describe('adversarial LogBuffer review cases', () => {
  it('cross-stream — label on stdout, secret on stderr is redacted', () => {
    registerSecret(SYN_CROSS)
    const buf = new LogBuffer({ now: () => 1 })
    buf.setVendor('tabby')
    buf.appendChunk('stdout', 'Your API key is:\n')
    buf.appendChunk('stderr', `${SYN_CROSS}\n`)
    const text = buf.getEntries().map((e) => e.text).join('\n')
    expect(text).not.toContain(SYN_CROSS)
    expect(text).toContain(REDACTION_MARKER)
  })

  it('70000 chars + newline — fail-closes without leaking payload', () => {
    const buf = new LogBuffer()
    registerSecret('y')
    const payload = `x${'y'.repeat(70_000)}`
    buf.appendChunk('stdout', `${payload}\n`)
    const entry = buf.getEntries().at(-1)
    expect(entry?.text).toContain('oversized line')
    expect(entry?.text).not.toContain('yyyy')
  })

  it('per-char registered secret through writer and resanitize listener', () => {
    const buf = new LogBuffer()
    buf.appendApp('error', `leak ${SYN_CHAR} end`)
    registerSecret(SYN_CHAR)
    expect(buf.getEntries().map((e) => e.text).join(' ')).not.toContain(SYN_CHAR)
  })
})

describe('adversarial download snapshot IPC/persist', () => {
  it('registered synthetic secret never appears in snapshot, emit, or JSON', () => {
    registerSecret('synthetic-download-adversary-777')
    const emitted: unknown[] = []
    const dir = mkdtempSync(join(tmpdir(), 'tabby-dl-adv-'))
    const file = join(dir, 'tabby-download.json')
    resetDownloadSessionForTests({
      persistFile: file,
      emit: (snap) => emitted.push(snap)
    })
    rememberDownloadForm({
      repoId: 'org/model',
      revision: 'main',
      folderName: 'model',
      token: 'synthetic-download-adversary-777'
    })
    beginOwnedDownload({
      operationId: 'adv',
      repoId: 'org/model',
      revision: 'main',
      folderName: 'model',
      downloadedBytes: 0,
      totalBytes: 100
    })
    const snap = getDownloadStatusSnapshot()
    const onDisk = readFileSync(file, 'utf-8')
    const emitJson = JSON.stringify(emitted[emitted.length - 1])
    expect(JSON.stringify(snap)).not.toContain('synthetic-download-adversary-777')
    expect(onDisk).not.toContain('synthetic-download-adversary-777')
    expect(emitJson).not.toContain('synthetic-download-adversary-777')
    expect(snapshotContainsSecrets(snap)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('adversarial historical scrub stateful label', () => {
  it('scrubs secret on line after credential label', () => {
    registerSecret('synthetic-scrub-line-secret-888')
    const state = createStatefulScrubState()
    const label = scrubLogLineStateful('Your admin key is:', state)
    expect(label).toContain('Your admin key is:')
    const value = scrubLogLineStateful('synthetic-scrub-line-secret-888', state)
    expect(value).toBe(REDACTION_MARKER)
  })
})

describe('auth watcher no-leak on key rotation', () => {
  it('registers new secrets before releasing old during re-register', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabby-watch-'))
    const cfg = {
      installDir: dir,
      pythonPath: '',
      configPath: '',
      host: '127.0.0.1',
      port: 5000,
      modelDir: '',
      autoStartServe: false
    }
    const path = join(dir, 'api_tokens.yml')
    writeFileSync(path, 'api_key: synthetic-watch-old-key-aaa\n', 'utf8')
    registerTabbyAuthSecrets(cfg)
    expect(sanitizeSecrets('synthetic-watch-old-key-aaa')).toContain(REDACTION_MARKER)
    writeFileSync(path, 'api_key: synthetic-watch-new-key-bbb\n', 'utf8')
    registerTabbyAuthSecrets(cfg)
    expect(sanitizeSecrets('synthetic-watch-new-key-bbb')).toContain(REDACTION_MARKER)
    expect(sanitizeSecrets('synthetic-watch-old-key-aaa')).toBe('synthetic-watch-old-key-aaa')
    rmSync(dir, { recursive: true, force: true })
  })

  it('immediate log after file rotation does not leak new or old secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabby-watch-live-'))
    const cfg = {
      installDir: dir,
      pythonPath: '',
      configPath: '',
      host: '127.0.0.1',
      port: 5000,
      modelDir: '',
      autoStartServe: false
    }
    const path = join(dir, 'api_tokens.yml')
    writeFileSync(path, 'api_key: synthetic-watch-old-key-aaa\n', 'utf8')
    registerTabbyAuthSecrets(cfg)
    const release = watchTabbyAuth(() => undefined, cfg)
    writeFileSync(path, 'api_key: synthetic-watch-new-key-bbb\n', 'utf8')
    registerTabbyAuthSecrets(cfg)
    const buf = new LogBuffer({ now: () => 1 })
    buf.setVendor('tabby')
    buf.appendChunk('stdout', 'Your API key is:\n')
    buf.appendChunk('stdout', 'synthetic-watch-new-key-bbb\n')
    const text = buf.getEntries().map((e) => e.text).join('\n')
    expect(text).not.toContain('synthetic-watch-new-key-bbb')
    expect(text).not.toContain('synthetic-watch-old-key-aaa')
    release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('fail-closed credential mode redacts unregistered key after label', () => {
    setCredentialFailClosed(true)
    const buf = new LogBuffer({ now: () => 1 })
    buf.setVendor('tabby')
    buf.appendChunk('stdout', 'Your API key is:\n')
    buf.appendChunk('stdout', 'synthetic-unregistered-key-999\n')
    const text = buf.getEntries().map((e) => e.text).join('\n')
    expect(text).not.toContain('synthetic-unregistered-key-999')
    expect(text).toContain(REDACTION_MARKER)
    setCredentialFailClosed(false)
  })
})

describe('adversarial IPC/state sanitization callsites', () => {
  it('updateInfo — error and releaseUrl sanitized', () => {
    registerSecret('synthetic-update-key-001')
    const raw = sanitizeUpdateInfo({
      current: '0.5.0',
      latest: null,
      updateAvailable: false,
      releaseUrl: 'https://github.com/ollama/ollama/releases?token=synthetic-update-key-001',
      checkedAt: Date.now(),
      error: 'network fail token=synthetic-update-key-001'
    })
    expect(JSON.stringify(raw)).not.toContain('synthetic-update-key-001')
  })

  it('killProcessResult — error sanitized', () => {
    registerSecret('synthetic-kill-secret-002')
    const out = sanitizeKillProcessResult({
      ok: false,
      error: 'failed token=synthetic-kill-secret-002'
    })
    expect(out.error).not.toContain('synthetic-kill-secret-002')
  })

  it('download conflict snapshot — no raw secret in RAM', () => {
    registerSecret('synthetic-conflict-secret-004')
    const dir = mkdtempSync(join(tmpdir(), 'dl-conflict-'))
    resetDownloadSessionForTests({ persistFile: join(dir, 'dl.json'), emit: () => {} })
    recordDownloadConflict({
      repoId: 'org/model',
      folderName: 'model',
      conflict: {
        folderName: 'model',
        bytesOnDisk: 100,
        expectedBytes: 200,
        completeness: 'partial',
        suggestedFolderName: 'model-2'
      },
      error: 'exists token=synthetic-conflict-secret-004'
    })
    const snap = getDownloadStatusSnapshot()
    expect(JSON.stringify(snap)).not.toContain('synthetic-conflict-secret-004')
    expect(snapshotContainsSecrets(snap)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('sanitizePathForState — strips query credentials', () => {
    registerSecret('synthetic-path-key-005')
    const out = sanitizePathForState('D:\\models\\repo?token=synthetic-path-key-005')
    expect(out).not.toContain('synthetic-path-key-005')
    expect(out).not.toContain('?token=')
  })

  it('speed test result — nested synthetic credential redacted in cache/IPC shape', () => {
    registerSecret('synthetic-speed-secret-006')
    clearAllSpeedTests()
    const raw = sanitizeSpeedTestResult({
      model: 'llama',
      prompt: 'token=synthetic-speed-secret-006',
      response: 'path C:\\models\\synthetic-speed-secret-006',
      thinking: '',
      ttftMs: 10,
      tokensPerSecond: 1,
      generatedTokens: 1,
      promptTokensPerSecond: 1,
      promptTokens: 1,
      promptEvalMs: 1,
      totalMs: 20,
      loadMs: 0,
      wasLoaded: true
    })
    recordSpeedTest('llama', raw)
    const cached = getSpeedTests()
    const json = JSON.stringify({ result: raw, cached })
    expect(json).not.toContain('synthetic-speed-secret-006')
    expect(raw.promptTokens).toBe(1)
  })

  it('pull progress — nested error/status/digest sanitized, numeric progress preserved', () => {
    registerSecret('synthetic-pull-secret-007')
    const raw = sanitizePullProgress({
      status: 'pulling token=synthetic-pull-secret-007',
      digest: 'sha256:synthetic-pull-secret-007',
      total: 4096,
      completed: 2048,
      error: { message: 'failed token=synthetic-pull-secret-007', path: 'C:\\pull\\synthetic-pull-secret-007' }
    })
    const json = JSON.stringify(raw)
    expect(json).not.toContain('synthetic-pull-secret-007')
    expect(raw.total).toBe(4096)
    expect(raw.completed).toBe(2048)
  })

  it('pull progress — nested arrays with objects sanitized at depth, shape preserved', () => {
    registerSecret('synthetic-nested-pull-secret-008')
    const raw = sanitizePullProgress({
      status: 'downloading',
      total: 8192,
      completed: 4096,
      layers: [
        { digest: 'sha256:synthetic-nested-pull-secret-008', size: 1024, ready: true },
        [{ token: 'synthetic-nested-pull-secret-008', ok: true, count: 3 }],
        'plain synthetic-nested-pull-secret-008'
      ],
      meta: { nested: [{ path: 'C:\\pull\\synthetic-nested-pull-secret-008', active: false }] }
    })
    const json = JSON.stringify(raw)
    expect(json).not.toContain('synthetic-nested-pull-secret-008')
    expect(raw.total).toBe(8192)
    expect(raw.completed).toBe(4096)
    const layers = (raw as unknown as Record<string, unknown>).layers as unknown[]
    const firstLayer = layers[0] as Record<string, unknown>
    expect(firstLayer.size).toBe(1024)
    expect(firstLayer.ready).toBe(true)
    const nestedRow = (layers[1] as unknown[])[0] as Record<string, unknown>
    expect(nestedRow.ok).toBe(true)
    expect(nestedRow.count).toBe(3)
  })

  it('pull progress — cycles and excessive depth fail-closed without stack overflow', () => {
    registerSecret('synthetic-cycle-pull-secret-009')
    const cyclic: Record<string, unknown> = {
      status: 'pulling synthetic-cycle-pull-secret-009',
      total: 1
    }
    cyclic.self = cyclic
    expect(() => JSON.stringify(sanitizePullProgress(cyclic))).not.toThrow()

    let deep: unknown = { status: 'ok', token: 'synthetic-cycle-pull-secret-009' }
    for (let i = 0; i < 40; i += 1) {
      deep = { nested: deep }
    }
    const deepRaw = sanitizePullProgress(deep)
    expect(JSON.stringify(deepRaw)).not.toContain('synthetic-cycle-pull-secret-009')
  })
})

describe('log scrub atomic with allowedRoots', () => {
  it('scrubs file inside provided log dir', async () => {
    registerSecret('synthetic-scrub-key-xyz')
    const dir = mkdtempSync(join(tmpdir(), 'log-scrub-'))
    const path = join(dir, 'tabby-serve.log')
    writeFileSync(
      path,
      ['normal startup line', 'Your API key is: synthetic-scrub-key-xyz', 'metrics ok'].join('\n'),
      'utf8'
    )
    const result = await scrubLogFileAtomic(path, { allowedRoots: [dir] })
    expect(result.ok).toBe(true)
    expect(readFileSync(path, 'utf8')).not.toContain('synthetic-scrub-key-xyz')
    rmSync(dir, { recursive: true, force: true })
  })
})
