import { describe, expect, it } from 'vitest'
import {
  ollamaPullProgressToAcquisition,
  tabbyDownloadProgressToAcquisition
} from './acquisition-progress'

describe('provider acquisition progress parity', () => {
  it('mapuje Ollama a Tabby bytes/total/percent do stejného kontraktu', () => {
    const ollama = ollamaPullProgressToAcquisition({
      status: 'pulling layer',
      digest: 'sha256:abc',
      completed: 25,
      total: 100
    })
    const tabby = tabbyDownloadProgressToAcquisition({
      status: 'running',
      bytesDownloaded: 25,
      bytesTotal: 100,
      percent: 25
    })

    expect({
      status: ollama.status,
      bytesDownloaded: ollama.bytesDownloaded,
      bytesTotal: ollama.bytesTotal,
      percent: ollama.percent
    }).toEqual({
      status: tabby.status,
      bytesDownloaded: tabby.bytesDownloaded,
      bytesTotal: tabby.bytesTotal,
      percent: tabby.percent
    })
  })

  it('nepřepíše poslední známé bytes u Ollama status řádku bez čísel', () => {
    expect(
      ollamaPullProgressToAcquisition({ status: 'success' })
    ).not.toHaveProperty('bytesDownloaded')
  })
})
