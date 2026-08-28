import { afterEach, describe, expect, it } from 'vitest'
import {
  finishDownloadSession,
  getDownloadSession,
  noteBackendLost,
  resetDownloadSessionForTests,
  startDownloadSession,
  updateDownloadSession,
  wasDownloadInterruptedByBackend
} from './download-session'

afterEach(() => {
  resetDownloadSessionForTests()
})

describe('download session', () => {
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
