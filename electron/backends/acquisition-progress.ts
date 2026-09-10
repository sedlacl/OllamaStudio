import type { AcquisitionState } from '../../shared/backend-contract'

export function ollamaPullProgressToAcquisition(progress: {
  status: string
  digest?: string
  total?: number
  completed?: number
}): Partial<AcquisitionState> {
  const total =
    typeof progress.total === 'number' && Number.isFinite(progress.total)
      ? Math.max(0, progress.total)
      : undefined
  const completed =
    typeof progress.completed === 'number' && Number.isFinite(progress.completed)
      ? Math.max(0, progress.completed)
      : undefined
  const state: Partial<AcquisitionState> = {
    status: 'running',
    details: { vendorStatus: progress.status, digest: progress.digest }
  }
  if (completed != null) state.bytesDownloaded = completed
  if (total != null) state.bytesTotal = total
  if (completed != null && total != null && total > 0) {
    state.percent = Math.max(0, Math.min(100, (completed / total) * 100))
  }
  return state
}

export function tabbyDownloadProgressToAcquisition(progress: {
  status: 'running' | 'success' | 'error'
  message?: string
  percent?: number | null
  bytesDownloaded?: number
  bytesTotal?: number | null
}): Partial<AcquisitionState> {
  return {
    status: progress.status === 'error' ? 'error' : progress.status,
    percent: progress.percent,
    bytesDownloaded: progress.bytesDownloaded,
    bytesTotal: progress.bytesTotal,
    error: progress.message
  }
}
