import { useCallback, useEffect, useState } from 'react'
import LoadedModelDetailsDialog from '../components/LoadedModelDetailsDialog'
import LoadModelDialog from '../components/LoadModelDialog'
import {
  api,
  type AppConfig,
  type ModelLoadOptions,
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

export default function Models(): JSX.Element {
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

  const refresh = useCallback(async () => {
    try {
      const [t, p] = await Promise.all([api().getModelsTags(), api().getModelsPs()])
      setTags(t)
      setRunning(p)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nepodařilo se načíst modely')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => {
    if (!pulling) return
    const unsub = api().onPullProgress(({ progress }) => setPullProgress(progress))
    return unsub
  }, [pulling])

  const isLoaded = (name: string): boolean => running.some((r) => r.name === name || r.model === name)

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
      setLoadError(e instanceof Error ? e.message : 'Nepodařilo se načíst nastavení modelu')
    } finally {
      setLoadLoading(false)
    }
  }

  const handleLoad = async (name: string, options?: ModelLoadOptions): Promise<void> => {
    setBusy(name)
    try {
      await api().modelLoad(name, options)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Načtení selhalo')
      throw e
    } finally {
      setBusy(null)
    }
  }

  const handleDialogLoad = async (options: ModelLoadOptions): Promise<void> => {
    if (!loadModel) return
    setLoadLoading(true)
    setLoadError(null)
    try {
      await handleLoad(loadModel.name, options)
      setLoadModel(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Načtení selhalo')
    } finally {
      setLoadLoading(false)
    }
  }

  const handleUnload = async (name: string): Promise<void> => {
    setBusy(name)
    try {
      await api().modelUnload(name)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Uvolnění selhalo')
    } finally {
      setBusy(null)
    }
  }

  const handleDelete = async (name: string): Promise<void> => {
    if (!confirm(`Smazat model „${name}"?`)) return
    setBusy(name)
    try {
      await api().modelDelete(name)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Smazání selhalo')
    } finally {
      setBusy(null)
    }
  }

  const handleShow = async (name: string): Promise<void> => {
    try {
      const data = await api().modelShow(name)
      setShowModal({ name, data })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Načtení detailu selhalo')
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
      setError(result.error ?? 'Stažení selhalo')
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
      setError(e instanceof Error ? e.message : 'Klonování selhalo')
    } finally {
      setBusy(null)
    }
  }

  const pullPercent =
    pullProgress?.total && pullProgress.completed
      ? Math.round((pullProgress.completed / pullProgress.total) * 100)
      : null

  return (
    <div>
      <h1 className="page-title">Modely</h1>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-field">
          <label>Stáhnout model (ollama pull)</label>
          <div className="btn-row">
            <input
              type="text"
              placeholder="např. llama3.2:3b"
              value={pullName}
              onChange={(e) => setPullName(e.target.value)}
              disabled={pulling}
              style={{ flex: 1, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6 }}
            />
            <button className="btn btn-primary" onClick={handlePull} disabled={pulling || !pullName.trim()}>
              {pulling ? 'Stahuje se…' : 'Stáhnout'}
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
          <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Načteno v paměti</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Model</th>
                <th>VRAM</th>
                <th>Akce</th>
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
                        title="Zobrazit všechny parametry"
                        aria-label={`Parametry modelu ${m.name}`}
                        onClick={() => setDetailsModel(m.name)}
                      >
                        …
                      </button>
                      <button
                        className="btn"
                        disabled={busy === m.name}
                        onClick={() => handleUnload(m.name)}
                      >
                        Uvolnit
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
        <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Lokální modely</h2>
        {loading ? (
          <p className="empty-state">Načítání…</p>
        ) : tags.length === 0 ? (
          <p className="empty-state">Žádné modely. Stáhněte model pomocí pole výše.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Název</th>
                <th>Velikost</th>
                <th>Stav</th>
                <th>Akce</th>
              </tr>
            </thead>
            <tbody>
              {tags.map((m) => (
                <tr key={m.digest}>
                  <td className="mono">{m.name}</td>
                  <td>{formatSize(m.size)}</td>
                  <td>{isLoaded(m.name) ? 'Načteno' : '—'}</td>
                  <td>
                    <div className="btn-row">
                      {!isLoaded(m.name) && (
                        <button
                          className="btn btn-primary"
                          disabled={busy === m.name}
                          onClick={() => void openLoadDialog(m)}
                        >
                          Načíst
                        </button>
                      )}
                      {isLoaded(m.name) && (
                        <button className="btn" disabled={busy === m.name} onClick={() => handleUnload(m.name)}>
                          Uvolnit
                        </button>
                      )}
                      <button className="btn" onClick={() => handleShow(m.name)}>
                        Detail
                      </button>
                      <button
                        className="btn"
                        onClick={() => {
                          setCloneModal(m.name)
                          setCloneDest(`${m.name}-copy`)
                        }}
                      >
                        Klonovat
                      </button>
                      <button className="btn btn-danger" disabled={busy === m.name} onClick={() => handleDelete(m.name)}>
                        Smazat
                      </button>
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
            <h3>Detail — {showModal.name}</h3>
            <pre className="mono" style={{ maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {showModal.data.parameters ?? showModal.data.modelfile ?? JSON.stringify(showModal.data, null, 2)}
            </pre>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowModal(null)}>
                Zavřít
              </button>
            </div>
          </div>
        </div>
      )}

      {cloneModal && (
        <div className="modal-backdrop" onClick={() => setCloneModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Klonovat model</h3>
            <p>Zdroj: <span className="mono">{cloneModal}</span></p>
            <div className="form-field">
              <label>Cílový název</label>
              <input value={cloneDest} onChange={(e) => setCloneDest(e.target.value)} />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setCloneModal(null)}>
                Zrušit
              </button>
              <button className="btn btn-primary" onClick={handleClone} disabled={!cloneDest.trim()}>
                Klonovat
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
