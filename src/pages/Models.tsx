import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ErrorBanner from '../components/ErrorBanner'
import LoadedModelDetailsDialog from '../components/LoadedModelDetailsDialog'
import LoadModelDialog from '../components/LoadModelDialog'
import LoadTabbyDialog from '../components/LoadTabbyDialog'
import ModelOverflowMenu, { type OverflowAction } from '../components/ModelOverflowMenu'
import ModelSplitTable from '../components/ModelSplitTable'
import ToolConfigIndicators from '../components/ToolConfigIndicators'
import { useModelSpeedTest } from '../components/useModelSpeedTest'
import { useI18n } from '../i18n/I18nProvider'
import {
  api,
  type AppConfig,
  type BackendCapabilities,
  type BackendId,
  type IntegrationsStatus,
  type ModelLoadOptions,
  type ModelLoadState,
  type ModelShow,
  type ModelTag,
  type PullProgress,
  type RunningModel,
  type TabbyDownloadFolderConflict,
  type TabbyDownloadStatusSnapshot,
  type HfRevision,
  type TabbyLoadOptions
} from '../types/api'

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${bytes} B`
}

function previewHfFolder(repoId: string, revision: string): string {
  const id = repoId
    .trim()
    .replace(/^https?:\/\/huggingface\.co\//i, '')
    .replace(/^(models|datasets)\//i, '')
    .replace(/\/+$/, '')
  const parts = id.split('/').filter(Boolean)
  const base = parts[parts.length - 1] ?? ''
  const rev = revision.trim()
  if (!base) return ''
  if (!rev || rev.toLowerCase() === 'main') return base
  return `${base}-${rev}`
}

function emptyIntegrations(): IntegrationsStatus {
  return {
    continue: { path: '', exists: false, invalid: false, byModel: {} },
    opencode: { path: '', exists: false, invalid: false, byModel: {} }
  }
}

export default function Models(): JSX.Element {
  const { t, formatDateTime } = useI18n()
  const navigate = useNavigate()
  const [tags, setTags] = useState<ModelTag[]>([])
  const [running, setRunning] = useState<RunningModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const errorSourceRef = useRef<'fetch' | 'action' | null>(null)
  const [pullName, setPullName] = useState('')
  const [pullProgress, setPullProgress] = useState<PullProgress | null>(null)
  const [pulling, setPulling] = useState(false)
  const [showModal, setShowModal] = useState<{ name: string; data: ModelShow } | null>(null)
  const [cloneModal, setCloneModal] = useState<string | null>(null)
  const [cloneDest, setCloneDest] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [loadModel, setLoadModel] = useState<ModelTag | null>(null)
  const [loadModelInfo, setLoadModelInfo] = useState<ModelShow | null>(null)
  const [loadServerConfig, setLoadServerConfig] = useState<AppConfig | null>(null)
  const [loadLoading, setLoadLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [detailsModel, setDetailsModel] = useState<string | null>(null)
  const [modelLoads, setModelLoads] = useState<ModelLoadState[]>([])
  const [loadNotice, setLoadNotice] = useState<string | null>(null)
  const [integrations, setIntegrations] = useState<IntegrationsStatus>(emptyIntegrations)
  const [toolBusy, setToolBusy] = useState<string | null>(null)
  const [activeBackend, setActiveBackend] = useState<BackendId>('ollama')
  const [capabilities, setCapabilities] = useState<BackendCapabilities | null>(null)
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

  const isTabby = activeBackend === 'tabby'
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

  const refreshIntegrations = useCallback(async (names: string[]): Promise<void> => {
    try {
      const status = await api().getIntegrationsStatus(names)
      setIntegrations(status)
    } catch {
      setIntegrations(emptyIntegrations())
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [tagsList, ps] = await Promise.all([api().getModelsTags(), api().getModelsPs()])
      setTags(tagsList)
      setRunning(ps)
      if (errorSourceRef.current !== 'action') {
        errorSourceRef.current = null
        setError(null)
      }
      await refreshIntegrations(tagsList.map((tag) => tag.name))
    } catch (e) {
      const raw = e instanceof Error ? e.message.trim() : ''
      const detail =
        raw && raw.toLowerCase() !== 'fetch failed' ? raw : t('models.fetchFailed')
      if (errorSourceRef.current !== 'action') {
        errorSourceRef.current = 'fetch'
        setError(
          detail === t('models.fetchFailed')
            ? detail
            : t('models.fetchFailedDetail', { detail })
        )
      }
    } finally {
      setLoading(false)
    }
  }, [refreshIntegrations, t])

  const speedTest = useModelSpeedTest(() => {
    void refresh()
  })

  useEffect(() => {
    void refresh()
    const id = setInterval(() => {
      void refresh()
    }, 8000)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => {
    api()
      .getServerConfig()
      .then((cfg) => setActiveBackend(cfg.activeBackend === 'tabby' ? 'tabby' : 'ollama'))
      .catch(() => {})
    api()
      .getBackendCapabilities()
      .then(setCapabilities)
      .catch(() => {})
  }, [])

  useEffect(() => {
    api().getModelLoadStatus().then(setModelLoads).catch(() => {})
    const unsub = api().onModelLoadStatus((state) => {
      setModelLoads((prev) => {
        const next = prev.filter((s) => s.name !== state.name)
        return [...next, state]
      })
      if (state.status === 'success') {
        setLoadNotice(t('models.loadSuccess', { name: state.name }))
        void refresh()
      } else if (state.status === 'error') {
        setError(
          t('models.loadFailed', {
            name: state.name,
            error: state.error ?? t('models.unknownError')
          })
        )
      }
    })
    return unsub
  }, [refresh, t])

  useEffect(() => {
    if (!pulling) return
    const unsub = api().onPullProgress(({ progress }) => setPullProgress(progress))
    return unsub
  }, [pulling])

  useEffect(() => {
    const unsub = api().onTabbyDownloadStatus((snap) => applyDownloadSnap(snap))
    void api().getTabbyDownloadStatus().then(applyDownloadSnap).catch(() => {})
    return unsub
  }, [applyDownloadSnap])

  useEffect(() => {
    if (!formHydratedRef.current) return
    const id = setTimeout(() => {
      void api()
        .rememberTabbyDownloadForm({
          repoId: hfRepoId,
          revision: hfRevision,
          folderName: hfFolderName
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

  const isLoading = (name: string): boolean =>
    modelLoads.some((s) => s.name === name && s.status === 'loading')

  const isRunning = (name: string): boolean =>
    running.some((r) => r.name === name || r.model === name)

  const openLoadDialog = async (model: ModelTag): Promise<void> => {
    setLoadModel(model)
    setLoadModelInfo(null)
    setLoadServerConfig(null)
    setLoadError(null)
    if (isTabby) {
      setLoadLoading(false)
      return
    }
    setLoadLoading(true)
    try {
      const [info, config] = await Promise.all([api().modelShow(model.name), api().getServerConfig()])
      setLoadModelInfo(info)
      setLoadServerConfig(config)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t('models.settingsFailed'))
    } finally {
      setLoadLoading(false)
    }
  }

  const handleLoad = async (
    name: string,
    options?: ModelLoadOptions | TabbyLoadOptions
  ): Promise<void> => {
    const result = await api().modelLoad(name, options)
    if (!result.ok) {
      setError(result.error ?? t('models.loadStartFailed'))
      throw new Error(result.error ?? t('models.loadStartFailed'))
    }
  }

  const handleDialogLoad = (options: ModelLoadOptions): void => {
    if (!loadModel) return
    const modelName = loadModel.name
    setLoadModel(null)
    setLoadError(null)
    setLoadNotice(null)
    setError(null)
    void handleLoad(modelName, options).catch(() => {})
  }

  const handleTabbyDialogLoad = (options: TabbyLoadOptions): void => {
    if (!loadModel) return
    const modelName = loadModel.name
    setLoadModel(null)
    setLoadError(null)
    setLoadNotice(null)
    setError(null)
    void handleLoad(modelName, options).catch(() => {})
  }

  const handleUnload = async (name: string): Promise<void> => {
    if (isTabby && !confirm(t('models.unloadConfirmTabby', { name }))) return
    setBusy(name)
    try {
      await api().modelUnload(name)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.unloadFailed'))
    } finally {
      setBusy(null)
    }
  }

  const handleDelete = async (name: string): Promise<void> => {
    if (!confirm(t('models.deleteConfirm', { name }))) return
    setBusy(name)
    try {
      await api().modelDelete(name)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.deleteFailed'))
    } finally {
      setBusy(null)
    }
  }

  const handleShow = async (name: string): Promise<void> => {
    try {
      const data = await api().modelShow(name)
      setShowModal({ name, data })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.detailFailed'))
    }
  }

  const handlePull = async (): Promise<void> => {
    const name = pullName.trim()
    if (!name) return
    setPulling(true)
    setPullProgress(null)
    setError(null)
    const result = await api().modelPull(name)
    setPulling(false)
    if (!result.ok) {
      setError(result.error ?? t('models.pullFailed'))
    } else {
      setPullName('')
      await refresh()
    }
  }

  const handleHfLoadRevisions = async (): Promise<void> => {
    const repoId = hfRepoId.trim()
    if (!repoId) return
    setHfRevisionsLoading(true)
    setHfRevisionsError(null)
    try {
      const result = await api().tabbyHfRefs({
        repoId,
        token: hfToken.trim() || undefined
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
    if (!repoId) return
    if (hfDownloading) return
    errorSourceRef.current = null
    setError(null)
    try {
      const folderName = (folderOverride ?? hfFolderName).trim() || undefined
      const result = await api().tabbyDownload({
        repoId,
        revision: hfRevision.trim() || undefined,
        folderName,
        token: hfToken.trim() || undefined
      })
      if (result.alreadyRunning) return
      if (result.folderConflict) {
        setHfConflict(result.folderConflict)
        setHfConflictError(null)
        return
      }
      if (!result.ok) {
        errorSourceRef.current = 'action'
        setError(result.error ?? t('models.hfDownloadFailed'))
        return
      }
      if (result.ok) {
        setHfToken('')
        await refresh()
      }
    } catch (e) {
      errorSourceRef.current = 'action'
      setError(e instanceof Error ? e.message : t('models.hfDownloadFailed'))
    }
  }

  const handleHfUseExisting = async (): Promise<void> => {
    const conflict = hfConflict ?? hfSession?.folderConflict
    if (!conflict) return
    const folder = conflict.folderName
    setHfConflict(null)
    setHfConflictError(null)
    setLoadNotice(t('models.hfFolderUsedExisting', { folder }))
    await api().dismissTabbyDownload().then(applyDownloadSnap).catch(() => {})
    await refresh()
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
      const result = await api().tabbyDeleteDownloadFolder(folder)
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

  const handleClone = async (): Promise<void> => {
    if (!cloneModal || !cloneDest.trim()) return
    setBusy(cloneModal)
    try {
      await api().modelCopy(cloneModal, cloneDest.trim())
      setCloneModal(null)
      setCloneDest('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.cloneFailed'))
    } finally {
      setBusy(null)
    }
  }

  const handleContinueUpsert = async (name: string): Promise<void> => {
    const wasPresent = integrations.continue.byModel[name]?.state === 'current'
      || integrations.continue.byModel[name]?.state === 'stale'
    setToolBusy(name)
    setError(null)
    try {
      const entry = await api().upsertContinueModel(name)
      setLoadNotice(
        t('models.continueUpserted', {
          name: entry.name,
          model: entry.model,
          action: wasPresent ? t('models.continueUpdated') : t('models.continueUploaded')
        })
      )
      await refreshIntegrations(tags.map((tag) => tag.name))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.continueWriteFailed'))
    } finally {
      setToolBusy(null)
    }
  }

  const handleContinueRemove = async (name: string): Promise<void> => {
    const match = integrations.continue.byModel[name]
    if (match?.state !== 'current' && match?.state !== 'stale') return
    if (!confirm(t('models.continueRemoveConfirm', { name: match.displayName ?? name }))) return
    setToolBusy(name)
    setError(null)
    try {
      await api().removeContinueModel(name)
      setLoadNotice(t('models.continueRemoved', { name: match.displayName ?? name }))
      await refreshIntegrations(tags.map((tag) => tag.name))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.continueRemoveFailed'))
    } finally {
      setToolBusy(null)
    }
  }

  const handleOpenCodeUpsert = async (name: string): Promise<void> => {
    const wasPresent = integrations.opencode.byModel[name]?.state === 'current'
      || integrations.opencode.byModel[name]?.state === 'stale'
    setToolBusy(name)
    setError(null)
    try {
      const entry = await api().upsertOpenCodeModel(name)
      setLoadNotice(
        t('models.opencodeUpserted', {
          name: entry.name,
          model: entry.model,
          action: wasPresent ? t('models.continueUpdated') : t('models.continueUploaded')
        })
      )
      await refreshIntegrations(tags.map((tag) => tag.name))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.opencodeWriteFailed'))
    } finally {
      setToolBusy(null)
    }
  }

  const handleOpenCodeRemove = async (name: string): Promise<void> => {
    const match = integrations.opencode.byModel[name]
    if (match?.state !== 'current' && match?.state !== 'stale') return
    if (!confirm(t('models.opencodeRemoveConfirm', { name: match.displayName ?? name }))) return
    setToolBusy(name)
    setError(null)
    try {
      await api().removeOpenCodeModel(name)
      setLoadNotice(t('models.opencodeRemoved', { name: match.displayName ?? name }))
      await refreshIntegrations(tags.map((tag) => tag.name))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.opencodeRemoveFailed'))
    } finally {
      setToolBusy(null)
    }
  }

  const overflowActions = (name: string): OverflowAction[] => {
    const continueMatch = integrations.continue.byModel[name]
    const opencodeMatch = integrations.opencode.byModel[name]
    const continuePresent = continueMatch?.state === 'current' || continueMatch?.state === 'stale'
    const opencodePresent = opencodeMatch?.state === 'current' || opencodeMatch?.state === 'stale'
    const busyHere = toolBusy === name
    const items: OverflowAction[] = []
    if (capabilities?.continueIntegration !== false) {
      items.push({
        id: 'continue-upsert',
        label: continuePresent ? t('models.updateContinue') : t('models.toContinue'),
        title: continuePresent ? t('models.updateContinueTitle') : t('models.toContinueTitle'),
        disabled: busyHere,
        onClick: () => void handleContinueUpsert(name)
      })
      if (continuePresent) {
        items.push({
          id: 'continue-remove',
          label: t('models.removeContinue'),
          title: t('models.removeContinueTitle'),
          danger: true,
          disabled: busyHere,
          onClick: () => void handleContinueRemove(name)
        })
      }
    }
    items.push({
      id: 'opencode-upsert',
      label: opencodePresent ? t('models.updateOpenCode') : t('models.toOpenCode'),
      title: opencodePresent ? t('models.updateOpenCodeTitle') : t('models.toOpenCodeTitle'),
      disabled: busyHere,
      onClick: () => void handleOpenCodeUpsert(name)
    })
    if (opencodePresent) {
      items.push({
        id: 'opencode-remove',
        label: t('models.removeOpenCode'),
        title: t('models.removeOpenCodeTitle'),
        danger: true,
        disabled: busyHere,
        onClick: () => void handleOpenCodeRemove(name)
      })
    }
    items.push(
      {
        id: 'speed-test',
        label: speedTest.busyModel === name ? t('speedTest.running') : t('speedTest.action'),
        title: t('speedTest.actionTitle'),
        disabled: speedTest.busyModel !== null || isLoading(name),
        separatorBefore: true,
        onClick: () => speedTest.run(name)
      },
      {
        id: 'detail',
        label: t('models.detail'),
        onClick: () => void handleShow(name)
      }
    )
    if (capabilities?.cloneModel !== false) {
      items.push({
        id: 'clone',
        label: t('models.clone'),
        onClick: () => {
          setCloneModal(name)
          setCloneDest(`${name}-copy`)
        }
      })
    }
    if (capabilities?.deleteModel !== false) {
      items.push({
        id: 'delete',
        label: t('models.delete'),
        danger: true,
        disabled: busy === name,
        separatorBefore: true,
        onClick: () => void handleDelete(name)
      })
    }
    return items
  }

  const currentLoadedId = running.length > 0 ? running[0].name : null

  const pullPercent =
    pullProgress?.total && pullProgress.completed
      ? Math.round((pullProgress.completed / pullProgress.total) * 100)
      : null

  const derivedHfFolder = previewHfFolder(hfRepoId, hfRevision)
  const hfRevisionSelectValue = hfRevisions.some((r) => r.name === hfRevision)
    ? hfRevision
    : ''
  const hfPercent =
    hfSession?.percent != null && Number.isFinite(hfSession.percent)
      ? hfSession.percent
      : null
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

  return (
    <div>
      <h1 className="page-title">{t('models.title')}</h1>

      {loadNotice && <div className="alert alert-info">{loadNotice}</div>}
      {error && (
        <ErrorBanner
          message={error}
          onDismiss={() => {
            errorSourceRef.current = null
            setError(null)
          }}
        />
      )}

      {modelLoads.some((s) => s.status === 'loading') && (
        <div className="alert alert-info" style={{ marginBottom: 16 }}>
          {t('models.loadingBg')}{' '}
          {modelLoads
            .filter((s) => s.status === 'loading')
            .map((s) => s.name)
            .join(', ')}
          {t('models.loadingBgHint')}
        </div>
      )}

      {capabilities?.hfDownload ? (
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
                list="hf-revision-options"
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
            <datalist id="hf-revision-options">
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
                  {t('models.hfDownloadRevision', {
                    revision: hfSession.revision || 'main'
                  })}
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
                    ? `${formatSize(hfSession.downloadedBytes)} / ${formatSize(hfSession.totalBytes)}`
                    : formatSize(hfSession.downloadedBytes)}
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
                        downloaded: formatSize(hfSession.folderConflict.bytesOnDisk),
                        total:
                          hfSession.folderConflict.expectedBytes != null
                            ? formatSize(hfSession.folderConflict.expectedBytes)
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
                      void api()
                        .dismissTabbyDownload()
                        .then(applyDownloadSnap)
                        .catch(() => {})
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
      ) : capabilities?.pullLibraryTag !== false ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="form-field">
            <label>{t('models.pullLabel')}</label>
            <div className="btn-row">
              <input
                type="text"
                placeholder={t('models.pullPlaceholder')}
                value={pullName}
                onChange={(e) => setPullName(e.target.value)}
                disabled={pulling}
                style={{ flex: 1, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6 }}
              />
              <button className="btn btn-primary" onClick={handlePull} disabled={pulling || !pullName.trim()}>
                {pulling ? t('models.downloading') : t('models.download')}
              </button>
            </div>
          </div>
          {pullProgress && (
            <div style={{ marginTop: 8 }}>
              <span className="mono">{pullProgress.status}</span>
              {pullPercent != null && (
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${pullPercent}%` }} />
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}

      {running.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
            {t('models.loadedInMemory')}
          </h2>
          <ModelSplitTable
            models={running.map((m) => ({
              name: m.name,
              size: m.size,
              sizeVram: m.size_vram ?? 0
            }))}
            onDetails={setDetailsModel}
            onSpeedTestFinished={() => {
              void refresh()
            }}
            extraActions={(name) => [
              {
                id: 'unload',
                label: t('models.unload'),
                disabled: busy === name,
                separatorBefore: true,
                onClick: () => void handleUnload(name)
              }
            ]}
          />
        </div>
      )}

      <div className="card">
        <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
          {t('models.localModels')}
        </h2>
        {(integrations.continue.path || integrations.opencode.path) && (
          <div className="model-paths">
            {integrations.continue.path && (
              <p className="metric-label" style={{ margin: 0 }}>
                {t('models.continuePath')} <span className="mono">{integrations.continue.path}</span>
              </p>
            )}
            {integrations.opencode.path && (
              <p className="metric-label" style={{ margin: 0 }}>
                {t('models.opencodePath')} <span className="mono">{integrations.opencode.path}</span>
              </p>
            )}
          </div>
        )}
        {loading ? (
          <p className="empty-state">{t('models.loading')}</p>
        ) : tags.length === 0 ? (
          <p className="empty-state">
            {isTabby ? t('models.emptyTabby') : t('models.empty')}
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('models.colName')}</th>
                <th>{t('models.colSize')}</th>
                <th>{t('models.colStatus')}</th>
                <th>{t('models.colTools')}</th>
                <th className="table-actions">{t('models.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {tags.map((m) => (
                <tr key={m.digest}>
                  <td className="mono">{m.name}</td>
                  <td>{formatSize(m.size)}</td>
                  <td>
                    {isLoading(m.name)
                      ? t('models.statusLoading')
                      : isRunning(m.name)
                        ? t('models.statusLoaded')
                        : '—'}
                  </td>
                  <td>
                    <ToolConfigIndicators
                      continueMatch={integrations.continue.byModel[m.name]}
                      opencodeMatch={integrations.opencode.byModel[m.name]}
                    />
                  </td>
                  <td className="table-actions">
                    <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                      {!isRunning(m.name) && (
                        <button
                          className="btn btn-primary"
                          disabled={busy === m.name || isLoading(m.name)}
                          onClick={() => void openLoadDialog(m)}
                        >
                          {isLoading(m.name) ? t('models.statusLoading') : t('models.load')}
                        </button>
                      )}
                      {isRunning(m.name) && (
                        <button
                          className="btn"
                          disabled={busy === m.name}
                          onClick={() => handleUnload(m.name)}
                        >
                          {t('models.unload')}
                        </button>
                      )}
                      <ModelOverflowMenu modelName={m.name} actions={overflowActions(m.name)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {loadModel && isTabby && (
        <LoadTabbyDialog
          model={loadModel}
          loading={loadLoading}
          error={loadError}
          currentLoadedId={currentLoadedId}
          onCancel={() => {
            if (!loadLoading) setLoadModel(null)
          }}
          onLoad={handleTabbyDialogLoad}
        />
      )}

      {loadModel && !isTabby && (
        <LoadModelDialog
          model={loadModel}
          modelInfo={loadModelInfo}
          serverConfig={loadServerConfig}
          loading={loadLoading}
          error={loadError}
          onCancel={() => {
            if (!loadLoading) setLoadModel(null)
          }}
          onLoad={handleDialogLoad}
        />
      )}

      {detailsModel && (
        <LoadedModelDetailsDialog modelName={detailsModel} onClose={() => setDetailsModel(null)} />
      )}

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
                    size: formatSize(hfConflict.bytesOnDisk)
                  })
                : hfConflict.completeness === 'partial'
                  ? t('models.hfFolderExistsPartial', {
                      folder: hfConflict.folderName,
                      size: formatSize(hfConflict.bytesOnDisk)
                    })
                  : t('models.hfFolderExistsUnknown', {
                      folder: hfConflict.folderName,
                      size: formatSize(hfConflict.bytesOnDisk)
                    })}
            </p>
            {hfConflict.expectedBytes != null && (
              <p className="field-help">
                {t('models.hfFolderExistsExpected', { size: formatSize(hfConflict.expectedBytes) })}
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

      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('models.detailTitle', { name: showModal.name })}</h3>
            <p className="field-help" style={{ marginBottom: 10 }}>
              {t('models.detailNote')}
            </p>
            <pre className="mono" style={{ maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {showModal.data.parameters ?? showModal.data.modelfile ?? JSON.stringify(showModal.data, null, 2)}
            </pre>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowModal(null)}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {cloneModal && (
        <div className="modal-backdrop" onClick={() => setCloneModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('models.cloneTitle')}</h3>
            <p>
              {t('models.cloneSource')} <span className="mono">{cloneModal}</span>
            </p>
            <div className="form-field">
              <label>{t('models.cloneDest')}</label>
              <input value={cloneDest} onChange={(e) => setCloneDest(e.target.value)} />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setCloneModal(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" onClick={handleClone} disabled={!cloneDest.trim()}>
                {t('models.clone')}
              </button>
            </div>
          </div>
        </div>
      )}

      {speedTest.dialog}
    </div>
  )
}
