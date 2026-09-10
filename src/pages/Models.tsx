import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ErrorBanner from '../components/ErrorBanner'
import LoadedModelDetailsDialog from '../components/LoadedModelDetailsDialog'
import ModelOverflowMenu, { type OverflowAction } from '../components/ModelOverflowMenu'
import ModelSplitTable from '../components/ModelSplitTable'
import ToolConfigIndicators from '../components/ToolConfigIndicators'
import { useModelSpeedTest } from '../components/useModelSpeedTest'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n'
import { useBackendProviders } from '../providers/BackendProviderContext'
import { formatBackendError, providerDisplayNameById } from '../providers/i18n-helpers'
import {
  isBackendId,
  modelRefKey,
  type BackendId,
  type CatalogModel,
  type ModelRef
} from '../../shared/backend-contract'
import {
  api,
  type AppConfig,
  type IntegrationsStatus,
  type ModelLoadOptions,
  type ModelLoadState,
  type ModelShow,
  type ModelTag,
  type RunningModel,
  type TabbyLoadOptions
} from '../types/api'

type ProviderFilter = 'all' | BackendId

function formatSize(bytes: number | null | undefined, unknownLabel = '—'): string {
  if (bytes == null) return unknownLabel
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

function catalogToModelTag(model: CatalogModel): ModelTag {
  const completeness = model.metadata?.completeness
  const local_status =
    completeness === 'incomplete'
      ? 'incomplete'
      : completeness === 'complete'
        ? 'complete'
        : completeness === 'unknown'
          ? 'unknown'
          : undefined
  return {
    name: model.modelId,
    model: model.modelId,
    modified_at: '',
    size: model.sizeBytes,
    digest: modelRefKey(model),
    local_status
  }
}

function isIncompleteRow(model: CatalogModel): boolean {
  return model.metadata?.completeness === 'incomplete'
}

function providerUnloadConfirmKey(providerId: BackendId): MessageKey {
  return `providers.${providerId}.unloadConfirm` as MessageKey
}

function providerEmptyCatalogKey(providerId: BackendId): MessageKey {
  return `providers.${providerId}.emptyCatalog` as MessageKey
}

export default function Models(): JSX.Element {
  const { t } = useI18n()
  const {
    catalog,
    refreshCatalog,
    descriptors,
    descriptorsById,
    getDefinition,
    renderSlot
  } = useBackendProviders()

  const [running, setRunning] = useState<RunningModel[]>([])
  const [error, setError] = useState<string | null>(null)
  const errorSourceRef = useRef<'fetch' | 'action' | null>(null)
  const [showModal, setShowModal] = useState<{ name: string; data: ModelShow } | null>(null)
  const [cloneModal, setCloneModal] = useState<string | null>(null)
  const [cloneDest, setCloneDest] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [loadTarget, setLoadTarget] = useState<CatalogModel | null>(null)
  const [loadModelInfo, setLoadModelInfo] = useState<ModelShow | null>(null)
  const [loadServerConfig, setLoadServerConfig] = useState<AppConfig | null>(null)
  const [loadLoading, setLoadLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [detailsModelRef, setDetailsModelRef] = useState<ModelRef | null>(null)
  const [modelLoads, setModelLoads] = useState<ModelLoadState[]>([])
  const [loadNotice, setLoadNotice] = useState<string | null>(null)
  const [integrations, setIntegrations] = useState<IntegrationsStatus>(emptyIntegrations)
  const [toolBusy, setToolBusy] = useState<string | null>(null)
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all')
  const [serveProviderId, setServeProviderId] = useState<BackendId>('ollama')

  const refreshIntegrations = useCallback(async (refs: ModelRef[]): Promise<void> => {
    try {
      const status = await api().getIntegrationsStatus(refs)
      setIntegrations(status)
    } catch {
      setIntegrations(emptyIntegrations())
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      await refreshCatalog()
      const ps = await api().getModelsPs()
      setRunning(ps)
      if (errorSourceRef.current !== 'action') {
        errorSourceRef.current = null
        setError(null)
      }
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
    }
  }, [refreshCatalog, t])

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
    const poll = (): void => {
      void api()
        .getServeStatus()
        .then((serve) => {
          if (serve.backend && isBackendId(serve.backend)) {
            setServeProviderId(serve.backend)
          }
        })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, 8000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    api().getModelLoadStatus().then(setModelLoads).catch(() => {})
    const unsub = api().onModelLoadStatus((state) => {
      const key = modelRefKey(state.ref)
      setModelLoads((prev) => {
        const next = prev.filter((s) => modelRefKey(s.ref) !== key)
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
    if (catalog.models.length === 0) return
    void refreshIntegrations(catalog.models.map(modelRefOf))
  }, [catalog.models, refreshIntegrations])

  const visibleModels = useMemo(() => {
    if (providerFilter === 'all') return catalog.models
    return catalog.models.filter((m) => m.providerId === providerFilter)
  }, [catalog.models, providerFilter])

  const modelRefOf = (model: CatalogModel): ModelRef => ({
    providerId: model.providerId,
    modelId: model.modelId
  })

  const isLoadingRef = (ref: ModelRef): boolean =>
    modelLoads.some((s) => modelRefKey(s.ref) === modelRefKey(ref) && s.status === 'loading')

  const isRunningModel = (model: CatalogModel): boolean => {
    if (model.loaded) return true
    if (model.providerId !== serveProviderId) return false
    return running.some((r) => r.name === model.modelId || r.model === model.modelId)
  }

  const openLoadDialog = async (model: CatalogModel): Promise<void> => {
    setLoadTarget(model)
    setLoadModelInfo(null)
    setLoadServerConfig(null)
    setLoadError(null)
    const descriptor = descriptorsById[model.providerId]
    if (descriptor?.acquisition !== 'ollama-library') {
      setLoadLoading(false)
      return
    }
    setLoadLoading(true)
    try {
      const [info, config] = await Promise.all([
        api().modelShow(model.modelId),
        api().getServerConfig()
      ])
      setLoadModelInfo(info)
      setLoadServerConfig(config)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t('models.settingsFailed'))
    } finally {
      setLoadLoading(false)
    }
  }

  const handleLoad = async (ref: ModelRef, profile?: ModelLoadOptions | TabbyLoadOptions): Promise<void> => {
    const result = await api().modelLoad({ ref, profile })
    if (!result.ok) {
      setError(result.error ?? t('models.loadStartFailed'))
      throw new Error(result.error ?? t('models.loadStartFailed'))
    }
  }

  const handleDialogLoad = (options: ModelLoadOptions | TabbyLoadOptions): void => {
    if (!loadTarget) return
    const ref = modelRefOf(loadTarget)
    setLoadTarget(null)
    setLoadError(null)
    setLoadNotice(null)
    setError(null)
    void handleLoad(ref, options).catch(() => {})
  }

  const handleUnload = async (model: CatalogModel): Promise<void> => {
    const caps = descriptorsById[model.providerId]?.capabilities
    const name = model.modelId
    if (caps && !caps.multiLoaded) {
      if (!confirm(t(providerUnloadConfirmKey(model.providerId), { name }))) return
    }
    setBusy(modelRefKey(model))
    try {
      await api().modelUnload(modelRefOf(model))
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.unloadFailed'))
    } finally {
      setBusy(null)
    }
  }

  const handleDelete = async (model: CatalogModel): Promise<void> => {
    const name = model.modelId
    if (!confirm(t('models.deleteConfirm', { name }))) return
    setBusy(modelRefKey(model))
    try {
      await api().modelDelete(name)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.deleteFailed'))
    } finally {
      setBusy(null)
    }
  }

  const handleShow = async (model: CatalogModel): Promise<void> => {
    try {
      const data = await api().modelShow(model.modelId)
      setShowModal({ name: model.modelId, data })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.detailFailed'))
    }
  }

  const handleDeleteIncompleteFolder = async (model: CatalogModel): Promise<void> => {
    const folder = model.modelId
    if (!confirm(t('models.deleteIncompleteConfirm', { folder }))) return
    setBusy(modelRefKey(model))
    setError(null)
    try {
      const remove = getDefinition(model.providerId)?.deleteIncompleteModel
      if (!remove) {
        setError(t('models.hfFolderDeleteFailed'))
        return
      }
      const result = await remove(folder)
      if (!result.ok) {
        setError(result.error ?? t('models.hfFolderDeleteFailed'))
        return
      }
      setLoadNotice(t('models.deleteIncompleteDone', { folder }))
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.hfFolderDeleteFailed'))
    } finally {
      setBusy(null)
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

  const handleContinueUpsert = async (model: CatalogModel): Promise<void> => {
    const ref = modelRefOf(model)
    const name = model.modelId
    const wasPresent =
      integrations.continue.byModel[modelRefKey(ref)]?.state === 'current' ||
      integrations.continue.byModel[modelRefKey(ref)]?.state === 'stale'
    setToolBusy(modelRefKey(ref))
    setError(null)
    try {
      const entry = await api().upsertContinueModel(ref)
      setLoadNotice(
        t('models.continueUpserted', {
          name: entry.name,
          model: entry.model,
          action: wasPresent ? t('models.continueUpdated') : t('models.continueUploaded')
        })
      )
      await refreshIntegrations(catalog.models.map(modelRefOf))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.continueWriteFailed'))
    } finally {
      setToolBusy(null)
    }
  }

  const handleContinueRemove = async (model: CatalogModel): Promise<void> => {
    const ref = modelRefOf(model)
    const name = model.modelId
    const match = integrations.continue.byModel[modelRefKey(ref)]
    if (match?.state !== 'current' && match?.state !== 'stale') return
    if (!confirm(t('models.continueRemoveConfirm', { name: match.displayName ?? name }))) return
    setToolBusy(modelRefKey(ref))
    setError(null)
    try {
      await api().removeContinueModel(ref)
      setLoadNotice(t('models.continueRemoved', { name: match.displayName ?? name }))
      await refreshIntegrations(catalog.models.map(modelRefOf))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.continueRemoveFailed'))
    } finally {
      setToolBusy(null)
    }
  }

  const handleOpenCodeUpsert = async (model: CatalogModel): Promise<void> => {
    const ref = modelRefOf(model)
    const name = model.modelId
    const wasPresent =
      integrations.opencode.byModel[modelRefKey(ref)]?.state === 'current' ||
      integrations.opencode.byModel[modelRefKey(ref)]?.state === 'stale'
    setToolBusy(modelRefKey(ref))
    setError(null)
    try {
      const entry = await api().upsertOpenCodeModel(ref)
      setLoadNotice(
        t('models.opencodeUpserted', {
          name: entry.name,
          model: entry.model,
          action: wasPresent ? t('models.continueUpdated') : t('models.continueUploaded')
        })
      )
      await refreshIntegrations(catalog.models.map(modelRefOf))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.opencodeWriteFailed'))
    } finally {
      setToolBusy(null)
    }
  }

  const handleOpenCodeRemove = async (model: CatalogModel): Promise<void> => {
    const ref = modelRefOf(model)
    const name = model.modelId
    const match = integrations.opencode.byModel[modelRefKey(ref)]
    if (match?.state !== 'current' && match?.state !== 'stale') return
    if (!confirm(t('models.opencodeRemoveConfirm', { name: match.displayName ?? name }))) return
    setToolBusy(modelRefKey(ref))
    setError(null)
    try {
      await api().removeOpenCodeModel(ref)
      setLoadNotice(t('models.opencodeRemoved', { name: match.displayName ?? name }))
      await refreshIntegrations(catalog.models.map(modelRefOf))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('models.opencodeRemoveFailed'))
    } finally {
      setToolBusy(null)
    }
  }

  const overflowActions = (model: CatalogModel): OverflowAction[] => {
    const name = model.modelId
    const ref = modelRefOf(model)
    const rowKey = modelRefKey(model)
    const descriptor = descriptorsById[model.providerId]
    const caps = descriptor?.capabilities
    const continueMatch = integrations.continue.byModel[rowKey]
    const opencodeMatch = integrations.opencode.byModel[rowKey]
    const continuePresent = continueMatch?.state === 'current' || continueMatch?.state === 'stale'
    const opencodePresent = opencodeMatch?.state === 'current' || opencodeMatch?.state === 'stale'
    const busyHere = toolBusy === rowKey
    const items: OverflowAction[] = []

    if (caps?.continueIntegration !== false) {
      items.push({
        id: 'continue-upsert',
        label: continuePresent ? t('models.updateContinue') : t('models.toContinue'),
        title: continuePresent ? t('models.updateContinueTitle') : t('models.toContinueTitle'),
        disabled: busyHere,
        onClick: () => void handleContinueUpsert(model)
      })
      if (continuePresent) {
        items.push({
          id: 'continue-remove',
          label: t('models.removeContinue'),
          title: t('models.removeContinueTitle'),
          danger: true,
          disabled: busyHere,
          onClick: () => void handleContinueRemove(model)
        })
      }
    }
    if (caps?.opencodeIntegration !== false) {
      items.push({
        id: 'opencode-upsert',
        label: opencodePresent ? t('models.updateOpenCode') : t('models.toOpenCode'),
        title: opencodePresent ? t('models.updateOpenCodeTitle') : t('models.toOpenCodeTitle'),
        disabled: busyHere,
        onClick: () => void handleOpenCodeUpsert(model)
      })
      if (opencodePresent) {
        items.push({
          id: 'opencode-remove',
          label: t('models.removeOpenCode'),
          title: t('models.removeOpenCodeTitle'),
          danger: true,
          disabled: busyHere,
          onClick: () => void handleOpenCodeRemove(model)
        })
      }
    }
    items.push(
      {
        id: 'speed-test',
        label:
          speedTest.busyModel === modelRefKey(ref)
            ? t('speedTest.running')
            : t('speedTest.action'),
        title: t('speedTest.actionTitle'),
        disabled: speedTest.busyModel !== null || isLoadingRef(ref),
        separatorBefore: true,
        onClick: () => speedTest.run(ref)
      },
      ...(descriptor?.acquisition === 'ollama-library'
        ? [
            {
              id: 'detail',
              label: t('models.detail'),
              onClick: () => void handleShow(model)
            } as OverflowAction
          ]
        : [])
    )
    if (caps?.cloneModel !== false) {
      items.push({
        id: 'clone',
        label: t('models.clone'),
        onClick: () => {
          setCloneModal(name)
          setCloneDest(`${name}-copy`)
        }
      })
    }
    if (caps?.deleteModel !== false) {
      items.push({
        id: 'delete',
        label: t('models.delete'),
        danger: true,
        disabled: busy === rowKey,
        separatorBefore: true,
        onClick: () => void handleDelete(model)
      })
    }
    if (isIncompleteRow(model) && caps?.hfDownload) {
      items.push({
        id: 'delete-incomplete-folder',
        label: t('models.deleteIncompleteFolder'),
        danger: true,
        disabled: busy === rowKey,
        separatorBefore: items.length > 0,
        onClick: () => void handleDeleteIncompleteFolder(model)
      })
    }
    return items
  }

  const currentLoadedId = useMemo(() => {
    if (!serveProviderId || running.length === 0) return null
    const caps = descriptorsById[serveProviderId]?.capabilities
    if (caps && !caps.multiLoaded) return running[0]?.name ?? null
    return null
  }, [serveProviderId, running, descriptorsById])

  const listLoading = catalog.loading && catalog.models.length === 0

  const emptyLabel =
    providerFilter === 'all'
      ? t('models.empty')
      : t(providerEmptyCatalogKey(providerFilter))

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

      {descriptors.map((descriptor) => {
        const code = catalog.providerErrors[descriptor.id]
        if (!code) return null
        return (
          <div key={`catalog-err-${descriptor.id}`} className="alert alert-error" role="alert">
            {providerDisplayNameById(t, descriptor.id, descriptorsById)}:{' '}
            {formatBackendError(t, { code })}
          </div>
        )
      })}

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

      {descriptors
        .filter((d) => d.acquisition != null)
        .map((descriptor) => (
          <div key={descriptor.id} className="card" style={{ marginBottom: 16 }}>
            {renderSlot(descriptor.id, 'AcquisitionPanel', {
              onModelsChanged: () => void refresh(),
              onError: (message: string) => {
                errorSourceRef.current = 'action'
                setError(message)
              }
            })}
          </div>
        ))}

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
            speedTestProviderId={serveProviderId}
            onDetails={(name) =>
              setDetailsModelRef({ providerId: serveProviderId, modelId: name })
            }
            onSpeedTestFinished={() => {
              void refresh()
            }}
            extraActions={(name) => [
              {
                id: 'unload',
                label: t('models.unload'),
                disabled: busy === modelRefKey({ providerId: serveProviderId, modelId: name }),
                separatorBefore: true,
                onClick: () =>
                  void handleUnload({
                    providerId: serveProviderId,
                    modelId: name,
                    displayName: name,
                    sizeBytes: null
                  })
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
        <div className="btn-row" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <label className="metric-label" style={{ margin: 0 }}>
            {t('logPanel.filtered')}
          </label>
          <select
            value={providerFilter}
            onChange={(e) => {
              const value = e.target.value
              setProviderFilter(value === 'all' || isBackendId(value) ? value : 'all')
            }}
            style={{
              padding: '6px 10px',
              border: '1px solid var(--border)',
              borderRadius: 6
            }}
          >
            <option value="all">{t('logPanel.all')}</option>
            {descriptors.map((d) => (
              <option key={d.id} value={d.id}>
                {t(d.displayNameKey as MessageKey)}
              </option>
            ))}
          </select>
        </div>
        {listLoading ? (
          <p className="empty-state">{t('models.loading')}</p>
        ) : visibleModels.length === 0 ? (
          <p className="empty-state">{emptyLabel}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('models.colName')}</th>
                <th>{t('nav.server')}</th>
                <th>{t('models.colSize')}</th>
                <th>{t('models.colStatus')}</th>
                <th>{t('models.colTools')}</th>
                <th className="table-actions">{t('models.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleModels.map((m) => {
                const ref = modelRefOf(m)
                const rowKey = modelRefKey(m)
                const incomplete = isIncompleteRow(m)
                const loadDisabled = busy === rowKey || isLoadingRef(ref) || incomplete
                const displayName = m.displayName.trim() || m.modelId
                return (
                  <tr key={rowKey}>
                    <td className="mono">{displayName}</td>
                    <td>
                      <span className="badge">{providerDisplayNameById(t, m.providerId, descriptorsById)}</span>
                    </td>
                    <td>{formatSize(m.sizeBytes, t('models.sizeUnknown'))}</td>
                    <td>
                      {isLoadingRef(ref)
                        ? t('models.statusLoading')
                        : isRunningModel(m)
                          ? t('models.statusLoaded')
                          : incomplete
                            ? t('models.statusIncomplete')
                            : '—'}
                    </td>
                    <td>
                      <ToolConfigIndicators
                        continueMatch={integrations.continue.byModel[rowKey]}
                        opencodeMatch={integrations.opencode.byModel[rowKey]}
                      />
                    </td>
                    <td className="table-actions">
                      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                        {!isRunningModel(m) && (
                          <button
                            className="btn btn-primary"
                            disabled={loadDisabled}
                            title={incomplete ? t('models.loadIncompleteDisabled') : undefined}
                            onClick={() => void openLoadDialog(m)}
                          >
                            {isLoadingRef(ref) ? t('models.statusLoading') : t('models.load')}
                          </button>
                        )}
                        {isRunningModel(m) && (
                          <button
                            className="btn"
                            disabled={busy === rowKey}
                            onClick={() => void handleUnload(m)}
                          >
                            {t('models.unload')}
                          </button>
                        )}
                        <ModelOverflowMenu modelName={displayName} actions={overflowActions(m)} />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {loadTarget &&
        renderSlot(loadTarget.providerId, 'ModelProfileEditor', {
          model: catalogToModelTag(loadTarget),
          modelInfo: loadModelInfo,
          serverConfig: loadServerConfig,
          loading: loadLoading,
          error: loadError,
          currentLoadedId,
          onCancel: () => {
            if (!loadLoading) setLoadTarget(null)
          },
          onLoad: handleDialogLoad
        })}

      {detailsModelRef && (
        <LoadedModelDetailsDialog
          modelRef={detailsModelRef}
          onClose={() => setDetailsModelRef(null)}
        />
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
