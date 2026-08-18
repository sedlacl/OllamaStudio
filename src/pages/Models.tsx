import { useCallback, useEffect, useState } from 'react'
import LoadedModelDetailsDialog from '../components/LoadedModelDetailsDialog'
import LoadModelDialog from '../components/LoadModelDialog'
import ModelOverflowMenu, { type OverflowAction } from '../components/ModelOverflowMenu'
import ToolConfigIndicators from '../components/ToolConfigIndicators'
import { useI18n } from '../i18n/I18nProvider'
import {
  api,
  type AppConfig,
  type IntegrationsStatus,
  type ModelLoadOptions,
  type ModelLoadState,
  type ModelShow,
  type ModelTag,
  type PullProgress,
  type RunningModel
} from '../types/api'

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${bytes} B`
}

function emptyIntegrations(): IntegrationsStatus {
  return {
    continue: { path: '', exists: false, invalid: false, byModel: {} },
    opencode: { path: '', exists: false, invalid: false, byModel: {} }
  }
}

export default function Models(): JSX.Element {
  const { t } = useI18n()
  const [tags, setTags] = useState<ModelTag[]>([])
  const [running, setRunning] = useState<RunningModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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
      setError(null)
      await refreshIntegrations(tagsList.map((tag) => tag.name))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.fetchFailed'))
    } finally {
      setLoading(false)
    }
  }, [refreshIntegrations, t])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => {
      void refresh()
    }, 8000)
    return () => clearInterval(id)
  }, [refresh])

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

  const isLoading = (name: string): boolean =>
    modelLoads.some((s) => s.name === name && s.status === 'loading')

  const isRunning = (name: string): boolean =>
    running.some((r) => r.name === name || r.model === name)

  const openLoadDialog = async (model: ModelTag): Promise<void> => {
    setLoadModel(model)
    setLoadModelInfo(null)
    setLoadServerConfig(null)
    setLoadError(null)
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

  const handleLoad = async (name: string, options?: ModelLoadOptions): Promise<void> => {
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

  const handleUnload = async (name: string): Promise<void> => {
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
    const items: OverflowAction[] = [
      {
        id: 'continue-upsert',
        label: continuePresent ? t('models.updateContinue') : t('models.toContinue'),
        title: continuePresent ? t('models.updateContinueTitle') : t('models.toContinueTitle'),
        disabled: busyHere,
        onClick: () => void handleContinueUpsert(name)
      }
    ]
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
        id: 'detail',
        label: t('models.detail'),
        separatorBefore: true,
        onClick: () => void handleShow(name)
      },
      {
        id: 'clone',
        label: t('models.clone'),
        onClick: () => {
          setCloneModal(name)
          setCloneDest(`${name}-copy`)
        }
      },
      {
        id: 'delete',
        label: t('models.delete'),
        danger: true,
        disabled: busy === name,
        separatorBefore: true,
        onClick: () => void handleDelete(name)
      }
    )
    return items
  }

  const pullPercent =
    pullProgress?.total && pullProgress.completed
      ? Math.round((pullProgress.completed / pullProgress.total) * 100)
      : null

  return (
    <div>
      <h1 className="page-title">{t('models.title')}</h1>

      {loadNotice && <div className="alert alert-info">{loadNotice}</div>}
      {error && <div className="alert alert-error">{error}</div>}

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

      {running.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
            {t('models.loadedInMemory')}
          </h2>
          <table className="table">
            <thead>
              <tr>
                <th>{t('models.colModel')}</th>
                <th>{t('models.colVram')}</th>
                <th>{t('models.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {running.map((m) => (
                <tr key={m.name}>
                  <td className="mono">{m.name}</td>
                  <td>{m.size_vram ? formatSize(m.size_vram) : '—'}</td>
                  <td>
                    <div className="btn-row">
                      <button
                        type="button"
                        className="btn btn-icon"
                        title={t('models.showParams')}
                        aria-label={t('models.modelParamsAria', { name: m.name })}
                        onClick={() => setDetailsModel(m.name)}
                      >
                        …
                      </button>
                      <button
                        className="btn"
                        disabled={busy === m.name}
                        onClick={() => handleUnload(m.name)}
                      >
                        {t('models.unload')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
          <p className="empty-state">{t('models.empty')}</p>
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

      {loadModel && (
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
    </div>
  )
}
