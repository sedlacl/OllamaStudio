import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useI18n } from '../../i18n/I18nProvider'
import {
  api,
  type AcquisitionState,
  type HfRevision,
  type TabbyDownloadFolderConflict,
  type TabbyDownloadStatusSnapshot
} from '../../types/api'
import type { AcquisitionPanelProps } from '../types'
import { formatDownloadSize, previewHfFolder } from './hf-utils'

function acquisitionToSnapshot(state: AcquisitionState): TabbyDownloadStatusSnapshot {
  const details =
    state.details && typeof state.details === 'object'
      ? (state.details as Record<string, unknown>)
      : {}
  const folderConflict = details.folderConflict as TabbyDownloadFolderConflict | undefined
  const repoId = typeof details.repoId === 'string' ? details.repoId : ''
  const revision = typeof details.revision === 'string' ? details.revision : ''
  const folderName =
    typeof details.folderName === 'string' ? details.folderName : state.modelId
  return {
    sequence: state.updatedAt,
    session: {
      sequence: state.updatedAt,
      operationId: state.operationId,
      status: state.status,
      repoId,
      revision,
      folderName,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      downloadedBytes: state.bytesDownloaded ?? 0,
      totalBytes: state.bytesTotal ?? null,
      percent: state.percent ?? null,
      bytesPerSec: state.bytesPerSec,
      etaSeconds: state.etaSeconds,
      error: state.error,
      folderConflict,
      dismissed: false
    },
    form: { repoId, revision, folderName }
  }
}

export default function TabbyAcquisitionPanel({
  onModelsChanged,
  onError
}: AcquisitionPanelProps): JSX.Element {
  const { t, formatDateTime } = useI18n()
  const navigate = useNavigate()
  const [hfRepoId, setHfRepoId] = useState('')
  const [hfRevision, setHfRevision] = useState('')
  const [hfFolderName, setHfFolderName] = useState('')
  const [hfToken, setHfToken] = useState('')
  const [downloadSnap, setDownloadSnap] = useState<TabbyDownloadStatusSnapshot | null>(null)
  const downloadSeqRef = useRef(-1)
  const formHydratedRef = useRef(false)
  const [hfRevisions, setHfRevisions] = useState<HfRevision[]>([])
  const [hfRevisionsLoading, setHfRevisionsLoading] = useState(false)
  const [hfRevisionsLoaded, setHfRevisionsLoaded] = useState(false)
  const [hfRevisionsError, setHfRevisionsError] = useState<string | null>(null)
  const [hfConflict, setHfConflict] = useState<TabbyDownloadFolderConflict | null>(null)
  const [hfConflictBusy, setHfConflictBusy] = useState(false)
  const [hfConflictError, setHfConflictError] = useState<string | null>(null)
  const [loadNotice, setLoadNotice] = useState<string | null>(null)

  const hfSession = downloadSnap?.session ?? null
  const hfDownloading = hfSession?.status === 'running'

  const applyDownloadSnap = useCallback((incoming: TabbyDownloadStatusSnapshot): void => {
    if (incoming.sequence <= downloadSeqRef.current) return
    downloadSeqRef.current = incoming.sequence
    setDownloadSnap(incoming)
    if (!formHydratedRef.current) {
      formHydratedRef.current = true
      setHfRepoId(incoming.form.repoId)
      setHfRevision(incoming.form.revision)
      setHfFolderName(incoming.form.folderName)
      if (incoming.session?.folderConflict) {
        setHfConflict(incoming.session.folderConflict)
      }
    }
  }, [])

  useEffect(() => {
    const applyAcquisition = (state: AcquisitionState): void => {
      if (state.providerId === 'tabby') applyDownloadSnap(acquisitionToSnapshot(state))
    }
    void api()
      .getModelAcquisitions()
      .then((states) => {
        const current = states.find((state) => state.providerId === 'tabby')
        if (current) applyAcquisition(current)
      })
      .catch(() => {})
    const unsub = api().onModelAcquisitionChanged(applyAcquisition)
    return unsub
  }, [applyDownloadSnap])

  useEffect(() => {
    if (!formHydratedRef.current) return
    const id = setTimeout(() => {
      void api()
        .invokeProviderAction({
          providerId: 'tabby',
          action: 'download.remember-form',
          payload: {
          repoId: hfRepoId,
          revision: hfRevision,
          folderName: hfFolderName
          }
        })
        .catch(() => {})
    }, 400)
    return () => clearTimeout(id)
  }, [hfRepoId, hfRevision, hfFolderName])

  useEffect(() => {
    setHfRevisions([])
    setHfRevisionsLoaded(false)
    setHfRevisionsError(null)
  }, [hfRepoId])

  const derivedHfFolder = previewHfFolder(hfRepoId, hfRevision)
  const hfRevisionSelectValue = hfRevisions.some((r) => r.name === hfRevision) ? hfRevision : ''
  const hfPercent =
    hfSession?.percent != null && Number.isFinite(hfSession.percent) ? hfSession.percent : null
  const hfHasDeterminateProgress = hfPercent != null
  const hfStatusLabel =
    hfSession?.status === 'running'
      ? t('models.hfDownloadStatusRunning')
      : hfSession?.status === 'success'
        ? t('models.hfDownloadStatusSuccess')
        : hfSession?.status === 'interrupted'
          ? t('models.hfDownloadStatusInterrupted')
          : hfSession?.status === 'conflict'
            ? t('models.hfDownloadStatusConflict')
            : hfSession?.status === 'error'
              ? t('models.hfDownloadStatusError')
              : null
  const hfTerminal =
    hfSession != null &&
    (hfSession.status === 'success' ||
      hfSession.status === 'error' ||
      hfSession.status === 'interrupted' ||
      hfSession.status === 'conflict')

  const fieldStyle = {
    padding: '8px 10px',
    border: '1px solid var(--border)',
    borderRadius: 6
  } as const

  const handleHfLoadRevisions = async (): Promise<void> => {
    const repoId = hfRepoId.trim()
    if (!repoId) return
    setHfRevisionsLoading(true)
    setHfRevisionsError(null)
    try {
      const result = await api().invokeProviderAction({
        providerId: 'tabby',
        action: 'hf.refs',
        payload: { repoId, token: hfToken.trim() || undefined }
      })
      if (!result.ok) {
        setHfRevisions([])
        setHfRevisionsLoaded(true)
        setHfRevisionsError(result.error ?? t('models.hfRevisionsFailed'))
        return
      }
      setHfRevisions(result.revisions ?? [])
      setHfRevisionsLoaded(true)
      setHfRevisionsError(null)
    } catch (e) {
      setHfRevisions([])
      setHfRevisionsLoaded(true)
      setHfRevisionsError(e instanceof Error ? e.message : t('models.hfRevisionsFailed'))
    } finally {
      setHfRevisionsLoading(false)
    }
  }

  const handleHfDownload = async (folderOverride?: string): Promise<void> => {
    const repoId = hfRepoId.trim()
    if (!repoId || hfDownloading) return
    try {
      const folderName = (folderOverride ?? hfFolderName).trim() || undefined
      const result = await api().startModelAcquisition({
        providerId: 'tabby',
        source: 'hugging-face',
        repoId,
        revision: hfRevision.trim() || undefined,
        modelId: folderName,
        folderName,
        token: hfToken.trim() || undefined
      })
      if (result.alreadyRunning) return
      const details =
        result.details && typeof result.details === 'object'
          ? (result.details as { folderConflict?: TabbyDownloadFolderConflict })
          : {}
      if (details.folderConflict) {
        setHfConflict(details.folderConflict)
        setHfConflictError(null)
        return
      }
      if (!result.ok) {
        onError?.(result.error ?? t('models.hfDownloadFailed'))
        return
      }
      setHfToken('')
      onModelsChanged?.()
    } catch (e) {
      onError?.(e instanceof Error ? e.message : t('models.hfDownloadFailed'))
    }
  }

  const handleHfUseExisting = async (): Promise<void> => {
    const conflict = hfConflict ?? hfSession?.folderConflict
    if (!conflict) return
    const folder = conflict.folderName
    const operationId = hfSession?.operationId
    setHfConflict(null)
    setHfConflictError(null)
    setLoadNotice(t('models.hfFolderUsedExisting', { folder }))
    if (operationId) await api().dismissModelAcquisition(operationId).catch(() => {})
    onModelsChanged?.()
  }

  const handleHfUseOtherFolder = async (): Promise<void> => {
    const conflict = hfConflict ?? hfSession?.folderConflict
    if (!conflict) return
    const name = conflict.suggestedFolderName
    setHfFolderName(name)
    setHfConflict(null)
    setHfConflictError(null)
    await handleHfDownload(name)
  }

  const handleHfDeleteAndRedownload = async (): Promise<void> => {
    const conflict = hfConflict ?? hfSession?.folderConflict
    if (!conflict) return
    if (!confirm(t('models.hfFolderDeleteConfirm', { folder: conflict.folderName }))) return
    setHfConflictBusy(true)
    setHfConflictError(null)
    const folder = conflict.folderName
    try {
      const result = await api().invokeProviderAction({
        providerId: 'tabby',
        action: 'download.delete-folder',
        payload: { folderName: folder }
      })
      if (!result.ok) {
        setHfConflictError(result.error ?? t('models.hfFolderDeleteFailed'))
        return
      }
      setHfConflict(null)
      await handleHfDownload(folder)
    } catch (e) {
      setHfConflictError(e instanceof Error ? e.message : t('models.hfFolderDeleteFailed'))
    } finally {
      setHfConflictBusy(false)
    }
  }

  return (
    <>
      {loadNotice && <div className="alert alert-info">{loadNotice}</div>}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-field">
          <label>{t('models.hfDownloadLabel')}</label>
          <input
            type="text"
            placeholder={t('models.hfRepoPlaceholder')}
            value={hfRepoId}
            onChange={(e) => setHfRepoId(e.target.value)}
            disabled={hfDownloading}
            style={{ marginBottom: 8, width: '100%', ...fieldStyle }}
          />
          <div className="btn-row" style={{ marginBottom: 8 }}>
            <button
              className="btn"
              onClick={() => void handleHfLoadRevisions()}
              disabled={hfDownloading || hfRevisionsLoading || !hfRepoId.trim()}
            >
              {hfRevisionsLoading ? t('models.hfLoadingRevisions') : t('models.hfLoadRevisions')}
            </button>
          </div>
          {hfRevisionsError && (
            <p className="field-help" style={{ color: 'var(--error)', marginTop: 0 }}>
              {hfRevisionsError}
            </p>
          )}
          {hfRevisionsLoaded && hfRevisions.length === 0 && !hfRevisionsError && (
            <p className="field-help" style={{ marginTop: 0 }}>
              {t('models.hfRevisionsEmpty')}
            </p>
          )}
          <div className="btn-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {hfRevisions.length > 0 && (
              <select
                value={hfRevisionSelectValue}
                onChange={(e) => setHfRevision(e.target.value)}
                disabled={hfDownloading}
                style={{ flex: 1, minWidth: 140, ...fieldStyle }}
                aria-label={t('models.hfRevisionPlaceholder')}
              >
                <option value="">{t('models.hfRevisionCustom')}</option>
                {hfRevisions.map((r) => (
                  <option key={`${r.type}:${r.name}`} value={r.name}>
                    {r.type === 'tag' ? `${r.name} (tag)` : r.name}
                  </option>
                ))}
              </select>
            )}
            <input
              type="text"
              list="hf-revision-options-tabby-panel"
              placeholder={t('models.hfRevisionPlaceholder')}
              value={hfRevision}
              onChange={(e) => setHfRevision(e.target.value)}
              disabled={hfDownloading}
              style={{ flex: 1, minWidth: 120, ...fieldStyle }}
            />
            <input
              type="text"
              placeholder={derivedHfFolder || t('models.hfFolderPlaceholder')}
              value={hfFolderName}
              onChange={(e) => setHfFolderName(e.target.value)}
              disabled={hfDownloading}
              style={{ flex: 1, minWidth: 120, ...fieldStyle }}
            />
          </div>
          <datalist id="hf-revision-options-tabby-panel">
            {hfRevisions.map((r) => (
              <option key={`list-${r.type}:${r.name}`} value={r.name} />
            ))}
          </datalist>
          <span className="field-help">
            {t('models.hfFolderHelp', { folder: derivedHfFolder || 'repo' })}
          </span>
          <input
            type="password"
            placeholder={t('models.hfTokenPlaceholder')}
            value={hfToken}
            onChange={(e) => setHfToken(e.target.value)}
            disabled={hfDownloading}
            autoComplete="off"
            style={{ marginTop: 8, width: '100%', ...fieldStyle }}
          />
          <span className="field-help">{t('models.hfTokenHelp')}</span>
          <span className="field-help">{t('models.hfDownloadRetrySemantics')}</span>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button
              className="btn btn-primary"
              onClick={() => void handleHfDownload()}
              disabled={hfDownloading || hfConflictBusy || !hfRepoId.trim()}
            >
              {hfDownloading ? t('models.downloading') : t('models.download')}
            </button>
          </div>
        </div>
        {hfSession && (
          <div
            className="download-status-panel"
            data-status={hfSession.status}
            role="status"
            aria-live="polite"
          >
            <strong>{t('models.hfDownloadStatusTitle')}</strong>
            <div className="download-status-meta">
              <span className="mono">{hfStatusLabel}</span>
              <span className="metric-label">
                {t('models.hfDownloadRepo', { repo: hfSession.repoId || '—' })}
              </span>
              <span className="metric-label">
                {t('models.hfDownloadRevision', { revision: hfSession.revision || 'main' })}
              </span>
              <span className="metric-label">
                {t('models.hfDownloadFolder', { folder: hfSession.folderName })}
              </span>
            </div>
            <div className="download-status-meta">
              <span className="mono">
                {hfHasDeterminateProgress
                  ? t('models.hfProgressPercent', { percent: hfPercent ?? 0 })
                  : t('models.hfProgressIndeterminate')}
              </span>
              <span className="metric-label">
                {hfSession.totalBytes != null
                  ? `${formatDownloadSize(hfSession.downloadedBytes)} / ${formatDownloadSize(hfSession.totalBytes)}`
                  : formatDownloadSize(hfSession.downloadedBytes)}
              </span>
            </div>
            <div
              className={`progress-bar${hfHasDeterminateProgress ? '' : ' indeterminate'}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={hfHasDeterminateProgress ? hfPercent ?? 0 : undefined}
              aria-busy={hfDownloading}
            >
              <div
                className="progress-fill"
                style={hfHasDeterminateProgress ? { width: `${hfPercent}%` } : undefined}
              />
            </div>
            <div className="download-status-meta">
              <span className="metric-label">
                {t('models.hfDownloadStartedAt', { time: formatDateTime(hfSession.startedAt) })}
              </span>
              <span className="metric-label">
                {t('models.hfDownloadUpdatedAt', { time: formatDateTime(hfSession.updatedAt) })}
              </span>
            </div>
            {hfSession.error && hfSession.status !== 'running' && (
              <p className="download-status-hint" style={{ color: 'var(--error)' }}>
                {hfSession.error}
              </p>
            )}
            {(hfSession.status === 'interrupted' || hfSession.status === 'error') && (
              <p className="download-status-hint">
                {hfSession.folderConflict
                  ? t('models.hfDownloadInterruptedHint', {
                      downloaded: formatDownloadSize(hfSession.folderConflict.bytesOnDisk),
                      total:
                        hfSession.folderConflict.expectedBytes != null
                          ? formatDownloadSize(hfSession.folderConflict.expectedBytes)
                          : '?'
                    })
                  : t('models.hfDownloadCleanupComplete')}
              </p>
            )}
            {hfSession.folderConflict && hfSession.status !== 'running' && (
              <p className="download-status-hint">{t('models.hfDownloadNoResume')}</p>
            )}
            <div className="btn-row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => navigate('/logs')}>
                {t('common.openLogs')}
              </button>
              {hfTerminal && (
                <button
                  className="btn"
                  onClick={() => {
                    if (hfSession?.operationId) {
                      void api().dismissModelAcquisition(hfSession.operationId).catch(() => {})
                    }
                  }}
                >
                  {t('models.hfDownloadDismiss')}
                </button>
              )}
              {hfSession.folderConflict && hfSession.status !== 'running' && (
                <>
                  <button
                    className="btn"
                    disabled={hfConflictBusy}
                    onClick={() => void handleHfUseOtherFolder()}
                  >
                    {t('models.hfFolderUseOtherName', {
                      folder: hfSession.folderConflict.suggestedFolderName
                    })}
                  </button>
                  <button
                    className="btn btn-danger"
                    disabled={hfConflictBusy}
                    onClick={() => void handleHfDeleteAndRedownload()}
                  >
                    {hfConflictBusy ? t('common.loading') : t('models.hfFolderDeleteAndRedownload')}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {hfConflict && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!hfConflictBusy && !hfDownloading) {
              setHfConflict(null)
              setHfConflictError(null)
            }
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(520px, 90vw)' }}>
            <h3>{t('models.hfFolderExistsTitle')}</h3>
            <p>
              {hfConflict.completeness === 'complete'
                ? t('models.hfFolderExistsComplete', {
                    folder: hfConflict.folderName,
                    size: formatDownloadSize(hfConflict.bytesOnDisk)
                  })
                : hfConflict.completeness === 'partial'
                  ? t('models.hfFolderExistsPartial', {
                      folder: hfConflict.folderName,
                      size: formatDownloadSize(hfConflict.bytesOnDisk)
                    })
                  : t('models.hfFolderExistsUnknown', {
                      folder: hfConflict.folderName,
                      size: formatDownloadSize(hfConflict.bytesOnDisk)
                    })}
            </p>
            {hfConflict.expectedBytes != null && (
              <p className="field-help">
                {t('models.hfFolderExistsExpected', { size: formatDownloadSize(hfConflict.expectedBytes) })}
              </p>
            )}
            {hfConflictError && (
              <div className="alert alert-error" style={{ marginTop: 8 }}>
                {hfConflictError}
              </div>
            )}
            <div className="modal-actions" style={{ flexWrap: 'wrap' }}>
              <button
                className="btn"
                disabled={hfConflictBusy || hfDownloading}
                onClick={() => {
                  setHfConflict(null)
                  setHfConflictError(null)
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                className={`btn${hfConflict.completeness === 'complete' ? ' btn-primary' : ''}`}
                disabled={hfConflictBusy || hfDownloading}
                onClick={() => void handleHfUseExisting()}
              >
                {t('models.hfFolderUseExisting')}
              </button>
              <button
                className={`btn${hfConflict.completeness !== 'complete' ? ' btn-primary' : ''}`}
                disabled={hfConflictBusy || hfDownloading}
                onClick={() => void handleHfUseOtherFolder()}
              >
                {t('models.hfFolderUseOtherName', { folder: hfConflict.suggestedFolderName })}
              </button>
              <button
                className="btn btn-danger"
                disabled={hfConflictBusy || hfDownloading}
                onClick={() => void handleHfDeleteAndRedownload()}
              >
                {hfConflictBusy ? t('common.loading') : t('models.hfFolderDeleteAndRedownload')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
