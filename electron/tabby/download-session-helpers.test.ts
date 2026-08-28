import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSafeModelSubdir } from './hf-download-helpers'
import {
  PERSISTED_DOWNLOAD_VERSION,
  PROGRESS_LOG_INTERVAL_MS,
  PROGRESS_LOG_PERCENT_STEP,
  applyDownloadStatusUpdate,
  canStartDownload,
  classifyRecoveredSession,
  formatDownloadLogLine,
  guardedFolderFromPersisted,
  parsePersistedDownloadFile,
  serializeDownloadForm,
  serializePersistedDownloadFile,
  shouldLogProgress,
  snapshotContainsSecrets,
  writeAtomicJson
} from './download-session-helpers'
import type { TabbyDownloadSessionView, TabbyDownloadStatusSnapshot } from './download-session-helpers'

function session(partial: Partial<TabbyDownloadSessionView>): TabbyDownloadSessionView {
  return {
    sequence: 1,
    operationId: 'dl-1',
    status: 'running',
    repoId: 'org/model',
    revision: 'main',
    folderName: 'model',
    startedAt: 1_000,
    updatedAt: 1_000,
    downloadedBytes: 0,
    totalBytes: 12_560_000_000,
    percent: 0,
    dismissed: false,
    ...partial
  }
}

function snapshot(
  sequence: number,
  sess: TabbyDownloadSessionView | null
): TabbyDownloadStatusSnapshot {
  return {
    sequence,
    session: sess,
    form: { repoId: 'org/model', revision: 'main', folderName: 'model' }
  }
}

describe('applyDownloadStatusUpdate (sequence ordering)', () => {
  it('accepts the first snapshot and ignores an older sequence', () => {
    const newer = snapshot(4, session({ sequence: 4, percent: 50, downloadedBytes: 6_000_000_000 }))
    const older = snapshot(2, session({ sequence: 2, percent: 10, downloadedBytes: 1_000_000_000 }))
    const afterNew = applyDownloadStatusUpdate(null, newer)
    expect(afterNew.sequence).toBe(4)
    expect(afterNew.session?.percent).toBe(50)
    const afterOld = applyDownloadStatusUpdate(afterNew, older)
    expect(afterOld).toBe(afterNew)
    expect(afterOld.session?.percent).toBe(50)
  })

  it('applies a later snapshot after remount-style subscribe-then-get', () => {
    const liveEvent = snapshot(8, session({ sequence: 8, percent: 42 }))
    const staleGet = snapshot(7, session({ sequence: 7, percent: 40 }))
    const current = applyDownloadStatusUpdate(null, liveEvent)
    expect(applyDownloadStatusUpdate(current, staleGet).session?.percent).toBe(42)
  })
})

describe('serializeDownloadForm — never persist or echo a token', () => {
  it('drops token and trims fields', () => {
    const form = serializeDownloadForm({
      repoId: '  org/qwen  ',
      revision: '  v2  ',
      folderName: '  qwen-v2  ',
      token: 'hf_SUPERSECRETTOKENVALUE'
    })
    expect(form).toEqual({ repoId: 'org/qwen', revision: 'v2', folderName: 'qwen-v2' })
    expect(JSON.stringify(form)).not.toMatch(/hf_|token|SECRET/i)
  })
})

describe('parsePersistedDownloadFile / serializePersistedDownloadFile', () => {
  it('round-trips a safe snapshot and strips secret fields', () => {
    const raw = serializePersistedDownloadFile({
      form: { repoId: 'org/model', revision: 'main', folderName: 'model' },
      session: session({
        error: 'failed Bearer hf_ABCDEFG0123456789',
        folderConflict: {
          folderName: 'model',
          bytesOnDisk: 100,
          expectedBytes: 200,
          completeness: 'partial',
          suggestedFolderName: 'model-2'
        }
      })
    })
    expect(raw).not.toMatch(/hf_ABCDEFG|Bearer hf_/i)
    expect(JSON.parse(raw).version).toBe(PERSISTED_DOWNLOAD_VERSION)
    const parsed = parsePersistedDownloadFile(raw)
    expect(parsed?.form.repoId).toBe('org/model')
    expect(parsed?.session?.folderName).toBe('model')
    expect(parsed?.session?.error).toContain('***')
    expect(snapshotContainsSecrets(parsed)).toBe(false)
  })

  it('ignores corrupt JSON, wrong version, and non-objects', () => {
    expect(parsePersistedDownloadFile('{')).toBeNull()
    expect(parsePersistedDownloadFile('[]')).toBeNull()
    expect(parsePersistedDownloadFile(JSON.stringify({ version: 99, form: {} }))).toBeNull()
    expect(parsePersistedDownloadFile(JSON.stringify({ version: 1, token: 'hf_x' }))).toBeNull()
  })

  it('rejects a payload whose form carries a token key even if nested', () => {
    const sneaky = JSON.stringify({
      version: 1,
      form: { repoId: 'org/m', revision: '', folderName: '', token: 'hf_abc' },
      session: null
    })
    const parsed = parsePersistedDownloadFile(sneaky)
    expect(parsed?.form).toEqual({ repoId: 'org/m', revision: '', folderName: '' })
    expect(JSON.stringify(parsed)).not.toMatch(/hf_abc|token/i)
  })
})

describe('atomic persist file', () => {
  const dirs: string[] = []
  afterEach(() => {
    dirs.length = 0
  })

  it('writes via tmp+rename and survives a leftover tmp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabby-dl-'))
    dirs.push(dir)
    const file = join(dir, 'tabby-download.json')
    writeFileSync(`${file}.tmp`, 'partial-garbage', 'utf-8')
    const payload = {
      form: { repoId: 'a/b', revision: '', folderName: 'b' },
      session: null as null
    }
    writeAtomicJson(file, JSON.parse(serializePersistedDownloadFile(payload)))
    const onDisk = readFileSync(file, 'utf-8')
    expect(parsePersistedDownloadFile(onDisk)?.form.repoId).toBe('a/b')
    expect(onDisk).not.toContain('partial-garbage')
  })
})

describe('classifyRecoveredSession running → interrupted', () => {
  it('reclassifies a crash-time running session and takes disk bytes', () => {
    const recovered = classifyRecoveredSession({
      now: 9_000,
      bytesOnDisk: 2_460_000_000,
      persisted: {
        version: 1,
        form: { repoId: 'org/model', revision: 'main', folderName: 'model' },
        session: session({ status: 'running', downloadedBytes: 1_000, totalBytes: 12_560_000_000 })
      }
    })
    expect(recovered.session?.status).toBe('interrupted')
    expect(recovered.session?.downloadedBytes).toBe(2_460_000_000)
    expect(recovered.didRestoreIncomplete).toBe(true)
    expect(recovered.session?.dismissed).toBe(false)
  })

  it('keeps error/interrupted/conflict until dismissed and drops success after restart', () => {
    const err = classifyRecoveredSession({
      now: 2,
      bytesOnDisk: 10,
      persisted: {
        version: 1,
        form: { repoId: 'a/b', revision: '', folderName: 'b' },
        session: session({ status: 'error', error: 'boom', dismissed: false })
      }
    })
    expect(err.session?.status).toBe('error')
    expect(err.didRestoreIncomplete).toBe(false)

    const ok = classifyRecoveredSession({
      now: 2,
      bytesOnDisk: 10,
      persisted: {
        version: 1,
        form: { repoId: 'a/b', revision: '', folderName: 'b' },
        session: session({ status: 'success', dismissed: false, percent: 100 })
      }
    })
    expect(ok.session).toBeNull()
    expect(ok.form.repoId).toBe('a/b')

    const dismissed = classifyRecoveredSession({
      now: 2,
      bytesOnDisk: 0,
      persisted: {
        version: 1,
        form: { repoId: 'a/b', revision: '', folderName: 'b' },
        session: session({ status: 'error', dismissed: true })
      }
    })
    expect(dismissed.session).toBeNull()
  })
})

describe('guardedFolderFromPersisted', () => {
  it('re-applies the path guard and refuses traversal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'models-'))
    mkdirSync(join(dir, 'safe-model'))
    const ok = guardedFolderFromPersisted(dir, 'safe-model')
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(resolveSafeModelSubdir(dir, 'safe-model').ok).toBe(true)
      expect(ok.folderName).toBe('safe-model')
    }
    expect(guardedFolderFromPersisted(dir, '..\\Windows').ok).toBe(false)
    expect(guardedFolderFromPersisted(dir, join(dir, 'safe-model')).ok).toBe(false)
  })
})

describe('shouldLogProgress throttling', () => {
  it('does not log every filesystem tick', () => {
    const prev = { loggedAt: 10_000, loggedPercent: 10, loggedBytes: 1_000 }
    expect(
      shouldLogProgress(prev, { now: 10_500, percent: 10, bytesDownloaded: 1_100 })
    ).toBe(false)
    expect(
      shouldLogProgress(prev, { now: 10_500, percent: 10 + PROGRESS_LOG_PERCENT_STEP, bytesDownloaded: 2_000 })
    ).toBe(true)
    expect(
      shouldLogProgress(prev, {
        now: 10_000 + PROGRESS_LOG_INTERVAL_MS,
        percent: 11,
        bytesDownloaded: 1_200
      })
    ).toBe(true)
  })
})

describe('formatDownloadLogLine', () => {
  it('formats start/progress/complete/interrupted/restored without secrets', () => {
    const base = {
      repoId: 'org/qwen',
      revision: 'main',
      folderName: 'qwen',
      downloadedBytes: 2_460_000_000,
      totalBytes: 12_560_000_000,
      percent: 19
    }
    expect(formatDownloadLogLine('start', { ...base, downloadedBytes: 0, percent: 0 })).toContain(
      '[studio] tabby-download start'
    )
    expect(formatDownloadLogLine('progress', base)).toMatch(/progress.*19/)
    expect(formatDownloadLogLine('complete', { ...base, percent: 100, downloadedBytes: 12_560_000_000 })).toContain(
      'complete'
    )
    expect(formatDownloadLogLine('interrupted', base)).toContain('interrupted')
    expect(formatDownloadLogLine('restored', base)).toMatch(/obnovena nedokončená session/)
    expect(formatDownloadLogLine('error', { ...base, error: 'hf_SECRETX' })).not.toMatch(/hf_SECRETX/)
  })
})

describe('canStartDownload — duplicate start', () => {
  it('blocks a second start while running and allows a new attempt after error', () => {
    expect(canStartDownload(session({ status: 'running' })).ok).toBe(false)
    expect(canStartDownload(session({ status: 'error' })).ok).toBe(true)
    expect(canStartDownload(session({ status: 'interrupted' })).ok).toBe(true)
    expect(canStartDownload(null).ok).toBe(true)
  })
})
