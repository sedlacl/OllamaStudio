import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  beginOwnedDownload,
  dismissDownloadSession,
  finishDownloadSession,
  getDownloadSession,
  getDownloadStatusSnapshot,
  noteBackendLost,
  recoverPersistedDownload,
  rememberDownloadForm,
  resetDownloadSessionForTests,
  startDownloadSession,
  updateDownloadProgress,
  updateDownloadSession,
  wasDownloadInterruptedByBackend
} from './download-session'

afterEach(() => {
  resetDownloadSessionForTests()
})

describe('download session (in-flight backend-loss flag)', () => {
  it('tracks progress and flags a backend loss only while a download is running', () => {
    expect(noteBackendLost()).toBe(false)
    startDownloadSession({
      operationId: 'dl-1',
      folderName: 'Qwen3.8-27B-exl3-SC_3.00bpw_H4',
      bytesDownloaded: 0,
      bytesTotal: 12_560_000_000
    })
    updateDownloadSession({ bytesDownloaded: 2_460_000_000 })
    expect(getDownloadSession()?.bytesDownloaded).toBe(2_460_000_000)
    expect(noteBackendLost()).toBe(true)
    expect(wasDownloadInterruptedByBackend()).toBe(true)
    finishDownloadSession()
    expect(getDownloadSession()).toBeNull()
    expect(wasDownloadInterruptedByBackend()).toBe(false)
  })
})

describe('owned download store', () => {
  it('returns the existing running session instead of starting a duplicate', () => {
    const first = beginOwnedDownload({
      operationId: 'dl-a',
      repoId: 'org/model',
      revision: 'main',
      folderName: 'model',
      downloadedBytes: 0,
      totalBytes: 100
    })
    expect(first.ok).toBe(true)
    const second = beginOwnedDownload({
      operationId: 'dl-b',
      repoId: 'org/other',
      revision: '',
      folderName: 'other',
      downloadedBytes: 0,
      totalBytes: 50
    })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.reason).toBe('already-running')
      expect(second.snapshot.session?.operationId).toBe('dl-a')
      expect(second.snapshot.session?.folderName).toBe('model')
    }
  })

  it('exposes in-flight progress for a remount snapshot without starting again', () => {
    beginOwnedDownload({
      operationId: 'dl-a',
      repoId: 'org/model',
      revision: 'main',
      folderName: 'model',
      downloadedBytes: 0,
      totalBytes: 100
    })
    updateDownloadProgress({ downloadedBytes: 40, totalBytes: 100, percent: 40 })
    const snap = getDownloadStatusSnapshot()
    expect(snap.session?.status).toBe('running')
    expect(snap.session?.downloadedBytes).toBe(40)
    expect(snap.sequence).toBeGreaterThan(0)
    expect(beginOwnedDownload({
      operationId: 'dl-remount',
      repoId: 'org/model',
      revision: 'main',
      folderName: 'model',
      downloadedBytes: 0,
      totalBytes: 100
    }).ok).toBe(false)
  })

  it('keeps an error session after in-flight finish so remount still sees it', () => {
    beginOwnedDownload({
      operationId: 'dl-a',
      repoId: 'org/model',
      revision: 'main',
      folderName: 'model',
      downloadedBytes: 0,
      totalBytes: 100
    })
    updateDownloadProgress({
      downloadedBytes: 40,
      totalBytes: 100,
      percent: 40,
      status: 'error',
      error: 'boom'
    })
    finishDownloadSession()
    expect(getDownloadSession()).toBeNull()
    expect(getDownloadStatusSnapshot().session?.status).toBe('error')
    expect(getDownloadStatusSnapshot().session?.error).toBe('boom')
  })

  it('persists form+session without token and recovers running as interrupted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabby-dl-store-'))
    const file = join(dir, 'tabby-download.json')
    resetDownloadSessionForTests({ persistFile: file, now: () => 5_000 })
    rememberDownloadForm({
      repoId: 'org/qwen',
      revision: 'main',
      folderName: 'qwen',
      token: 'hf_SHOULDNEVERPERSIST'
    })
    beginOwnedDownload({
      operationId: 'dl-z',
      repoId: 'org/qwen',
      revision: 'main',
      folderName: 'qwen',
      downloadedBytes: 10,
      totalBytes: 100
    })
    updateDownloadProgress({ downloadedBytes: 40, totalBytes: 100, percent: 40 })
    const onDisk = readFileSync(file, 'utf-8')
    expect(onDisk).not.toMatch(/hf_|token|SHOULDNEVER/i)
    expect(onDisk).toContain('org/qwen')

    resetDownloadSessionForTests({ persistFile: file, now: () => 9_000 })
    const modelDir = mkdtempSync(join(tmpdir(), 'models-'))
    mkdirSync(join(modelDir, 'qwen'))
    writeFileSync(join(modelDir, 'qwen', 'partial.bin'), 'xxxx')
    const recovered = await recoverPersistedDownload({
      modelDir,
      measureBytes: async () => 40
    })
    expect(recovered.session?.status).toBe('interrupted')
    expect(recovered.session?.downloadedBytes).toBe(40)
    expect(recovered.form.repoId).toBe('org/qwen')
    expect(JSON.stringify(recovered)).not.toMatch(/hf_|SHOULDNEVER/i)
  })

  it('throttles progress logs instead of logging every tick', () => {
    const logs: string[] = []
    let now = 5_000
    resetDownloadSessionForTests({
      now: () => now,
      log: (_level, text) => logs.push(text)
    })
    beginOwnedDownload({
      operationId: 'dl-log',
      repoId: 'org/model',
      revision: 'main',
      folderName: 'model',
      downloadedBytes: 0,
      totalBytes: 100
    })
    now += 200
    updateDownloadProgress({ downloadedBytes: 10, totalBytes: 100, percent: 10 })
    now += 200
    updateDownloadProgress({ downloadedBytes: 11, totalBytes: 100, percent: 11 })
    const progressLogs = logs.filter((line) => line.includes('progress'))
    expect(logs.some((line) => line.includes('tabby-download start'))).toBe(true)
    expect(progressLogs).toHaveLength(1)
    expect(progressLogs[0]).toContain('10 %')
  })

  it('does not resurrect a dismissed incident after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabby-dl-store-'))
    const file = join(dir, 'tabby-download.json')
    resetDownloadSessionForTests({ persistFile: file, now: () => 1_000 })
    beginOwnedDownload({
      operationId: 'dl-e',
      repoId: 'org/m',
      revision: '',
      folderName: 'm',
      downloadedBytes: 1,
      totalBytes: 10
    })
    updateDownloadProgress({
      downloadedBytes: 1,
      totalBytes: 10,
      percent: 10,
      status: 'error',
      error: 'boom'
    })
    dismissDownloadSession()
    resetDownloadSessionForTests({ persistFile: file, now: () => 2_000 })
    const recovered = await recoverPersistedDownload({
      modelDir: mkdtempSync(join(tmpdir(), 'models-')),
      measureBytes: async () => 0
    })
    expect(recovered.session).toBeNull()
    expect(recovered.form.repoId).toBe('org/m')
  })
})
