import { useEffect, useState } from 'react'
import LoadedModelDetailsDialog from '../components/LoadedModelDetailsDialog'
import LogPanel from '../components/LogPanel'
import {
  api,
  type ActiveRequest,
  type ActiveRequestPhase,
  type DashboardData,
  type ModelLoadState,
  type RequestHistoryItem,
  type RequestHistoryResult
} from '../types/api'
function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb.toFixed(0)} MB`
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function connectionLabel(c: string): string {
  const map: Record<string, string> = {
    connected: 'Připojeno',
    disconnected: 'Odpojeno',
    starting: 'Čeká na API',
    error: 'Chyba'
  }
  return map[c] ?? c
}

function phaseLabel(phase: ActiveRequestPhase): string {
  const map: Record<ActiveRequestPhase, string> = {
    prompt_processing: 'Zpracování promptu',
    generation: 'Generování',
    caching: 'Cache / KV',
    done: 'Dokončeno',
    unknown: 'Neznámá fáze'
  }
  return map[phase]
}

function formatElapsed(seconds: number | null): string {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s.toFixed(0)}s`
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('cs-CZ', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function resultLabel(result: RequestHistoryResult): string {
  return result === 'done' ? 'Dokončeno' : 'Stale / timeout'
}

function formatTokenPair(prompt: number | null, generation: number | null): string {
  if (prompt == null && generation == null) return '—'
  const p = prompt != null ? prompt.toLocaleString('cs-CZ') : '—'
  const g = generation != null ? generation.toLocaleString('cs-CZ') : '—'
  return `${p} / ${g}`
}

function formatTpsPair(prompt: number | null, generation: number | null): string {
  if (prompt == null && generation == null) return '—'
  const p = prompt != null ? prompt.toFixed(1) : '—'
  const g = generation != null ? generation.toFixed(1) : '—'
  return `${p} / ${g}`
}

function ActiveRequestCard({ req }: { req: ActiveRequest }): JSX.Element {
  const showBar = req.progressPercent != null
  const pct = showBar ? Math.min(100, Math.max(0, req.progressPercent!)) : null

  return (
    <div className={`active-req ${req.status === 'completed' ? 'active-req-done' : ''}`}>
      <div className="active-req-header">
        <div className="active-req-ids">
          <span className="mono">task {req.taskId}</span>
          {req.slotId != null && <span className="mono">slot {req.slotId}</span>}
        </div>
        <span className="active-req-phase">{phaseLabel(req.phase)}</span>
      </div>

      {showBar && (
        <div className="progress-bar active-req-bar">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}

      <div className="active-req-metrics">
        <div>
          <div className="metric-label">Progress</div>
          <div className="active-req-value">
            {pct != null ? `${pct.toFixed(0)} %` : '—'}
          </div>
        </div>
        <div>
          <div className="metric-label">Tokeny</div>
          <div className="active-req-value">
            {req.nTokens != null ? req.nTokens.toLocaleString('cs-CZ') : '—'}
          </div>
        </div>
        <div>
          <div className="metric-label">Čas</div>
          <div className="active-req-value">{formatElapsed(req.elapsedSeconds)}</div>
        </div>
        <div>
          <div className="metric-label">Tokeny/s</div>
          <div className="active-req-value">
            {req.tokensPerSec != null ? req.tokensPerSec.toFixed(1) : '—'}
          </div>
        </div>
      </div>
    </div>
  )
}

function HistoryRow({ item }: { item: RequestHistoryItem }): JSX.Element {
  const resultClass =
    item.result === 'done' ? 'history-result-done' : 'history-result-stale'
  const reason =
    item.completionReason ??
    (item.phase && item.phase !== 'done' ? phaseLabel(item.phase) : null)

  return (
    <tr>
      <td className="mono">{item.taskId}</td>
      <td className="mono">{item.slotId != null ? item.slotId : '—'}</td>
      <td>
        <span className={resultClass}>{resultLabel(item.result)}</span>
        {reason && <div className="history-reason">{reason}</div>}
      </td>
      <td>
        {item.progressPercent != null ? `${item.progressPercent.toFixed(0)} %` : '—'}
      </td>
      <td className="mono">
        {formatTokenPair(item.promptTokens, item.generationTokens)}
      </td>
      <td>{formatElapsed(item.elapsedSeconds)}</td>
      <td className="mono">
        {formatTpsPair(item.promptTokensPerSec, item.generationTokensPerSec)}
      </td>
      <td className="mono">{formatClock(item.startedAt)}</td>
      <td className="mono">{formatClock(item.completedAt)}</td>
    </tr>
  )
}

export default function Dashboard(): JSX.Element {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailsModel, setDetailsModel] = useState<string | null>(null)
  const [modelLoads, setModelLoads] = useState<ModelLoadState[]>([])

  useEffect(() => {
    api().getModelLoadStatus().then(setModelLoads).catch(() => {})
    const unsubLoad = api().onModelLoadStatus((state) => {
      setModelLoads((prev) => {
        const next = prev.filter((s) => s.name !== state.name)
        if (state.status === 'loading' || state.status === 'error') {
          return [...next, state]
        }
        return [...next, state]
      })
    })
    return unsubLoad
  }, [])

  useEffect(() => {    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const load = async (): Promise<void> => {
      try {
        const d = await api().getDashboard()
        setData(d)
      } catch {
        /* server may be down */
      } finally {
        setLoading(false)
      }
    }

    const scheduleRefresh = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void load()
      }, 150)
    }

    void load()
    const pollId = setInterval(load, 2000)
    const unsubRequests = api().subscribeDashboardRequests(scheduleRefresh)

    return () => {
      clearInterval(pollId)
      if (debounceTimer) clearTimeout(debounceTimer)
      unsubRequests()
    }
  }, [])

  if (loading && !data) {
    return (
      <div className="dashboard-page">
        <p className="empty-state">Načítání metrik…</p>
      </div>
    )
  }

  const gpu = data?.gpu
  const vramUsed = gpu ? gpu.memoryUsedMb : data?.vramFallbackMb
  const vramTotal = gpu?.memoryTotalMb ?? null
  const details = data?.activeRequestDetails ?? []
  const history = data?.requestHistory ?? []
  const activeModelLoads = modelLoads.filter((s) => s.status === 'loading')
  const failedModelLoads = modelLoads.filter((s) => s.status === 'error')

  return (
    <div className="dashboard-page">
      <div className="dashboard-top">
      <h1 className="page-title">Přehled</h1>

      {activeModelLoads.length > 0 && (
        <div className="alert alert-info" style={{ marginBottom: 16 }}>
          Načítání modelů na pozadí:{' '}
          {activeModelLoads.map((s) => (
            <span key={s.name} className="mono">
              {s.name}
            </span>
          ))}
          . Průběh sledujte v logu níže.
        </div>
      )}

      {failedModelLoads.map((s) => (
        <div key={s.name} className="alert alert-error" style={{ marginBottom: 16 }}>
          Načtení modelu <span className="mono">{s.name}</span> selhalo: {s.error}
        </div>
      ))}

      <div className="btn-row" style={{ marginBottom: 16 }}>        <button className="btn btn-primary" onClick={() => api().startServer().catch(() => {})}>
          Spustit serve
        </button>
        <button className="btn" onClick={() => api().stopServer().catch(() => {})}>
          Zastavit serve
        </button>
        <button className="btn" onClick={() => api().restartServer().catch(() => {})}>
          Restartovat serve
        </button>
      </div>

      <div className="card-grid">
        <div className="card">
          <div className="metric-label">Stav API</div>
          <div className="metric-value">{data ? connectionLabel(data.connection) : '—'}</div>
          {data?.version && <div className="metric-label">Verze {data.version}</div>}
        </div>

        <div className="card">
          <div className="metric-label">GPU / VRAM</div>
          <div className="metric-value">
            {vramUsed != null
              ? vramTotal != null
                ? `${formatMb(vramUsed)} / ${formatMb(vramTotal)}`
                : formatMb(vramUsed)
              : '—'}
          </div>
          {gpu && (
            <div className="metric-label">
              {gpu.name}
              {gpu.utilizationPercent != null ? ` · ${gpu.utilizationPercent}%` : ''}
            </div>
          )}
          {!gpu && vramUsed != null && (
            <div className="metric-label">Odhad z /api/ps (nvidia-smi nedostupné)</div>
          )}
        </div>

        <div className="card">
          <div className="metric-label">Načtené modely</div>
          <div className="metric-value">{data?.loadedCount ?? 0}</div>
        </div>

        <div className="card">
          <div className="metric-label">Paměť procesu serve</div>
          <div className="metric-value">
            {data?.memory.workingSetMb ? formatMb(data.memory.workingSetMb) : '—'}
          </div>
          {data?.memory.pid && <div className="metric-label">PID {data.memory.pid}</div>}
        </div>

        <div className="card">
          <div className="metric-label">Aktivní požadavky</div>
          <div className="metric-value">
            {data?.activeRequests != null ? data.activeRequests : '—'}
          </div>
          <div className="metric-label">Odhad z logů</div>
        </div>

        <div className="card">
          <div className="metric-label">Tokeny/s</div>
          <div className="metric-value">
            {data?.tokensPerSec != null ? data.tokensPerSec.toFixed(1) : '—'}
          </div>
          <div className="metric-label">Klouzavý průměr z logů</div>
        </div>

        <div className="card">
          <div className="metric-label">Uptime serve</div>
          <div className="metric-value">{formatUptime(data?.uptimeSeconds ?? null)}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="active-req-section-header">
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Aktivní požadavky (live)</h2>
          <span className="metric-label" style={{ margin: 0 }}>
            Parsováno z Ollama / llama runner logů (slot · task)
          </span>
        </div>

        {details.length === 0 ? (
          <p className="empty-state" style={{ padding: '16px 0 4px' }}>
            Žádný aktivní požadavek v logách
          </p>
        ) : (
          <div className="active-req-list">
            {details.map((req) => (
              <ActiveRequestCard key={req.taskId} req={req} />
            ))}
          </div>
        )}
      </div>

      {data && data.loadedModels.length > 0 && (
        <div className="card">
          <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Načtené modely</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Název</th>
                <th>VRAM</th>
                <th aria-label="Akce" />
              </tr>
            </thead>
            <tbody>
              {data.loadedModels.map((m) => (
                <tr key={m.name}>
                  <td className="mono">{m.name}</td>
                  <td>{m.sizeVram ? formatMb(m.sizeVram / (1024 * 1024)) : '—'}</td>
                  <td className="table-actions">
                    <button
                      type="button"
                      className="btn btn-icon"
                      title="Zobrazit všechny parametry"
                      aria-label={`Parametry modelu ${m.name}`}
                      onClick={() => setDetailsModel(m.name)}
                    >
                      …
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detailsModel && (
        <LoadedModelDetailsDialog modelName={detailsModel} onClose={() => setDetailsModel(null)} />
      )}
      </div>

      <div className="card dashboard-history-section">
        <div className="active-req-section-header">
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Poslední požadavky</h2>
          <span className="metric-label" style={{ margin: 0 }}>
            Max. 10 · nejnovější nahoře
          </span>
        </div>

        <div className="dashboard-history-body">
          {history.length === 0 ? (
            <p className="history-empty">Zatím žádná historie požadavků</p>
          ) : (
            <div className="history-table-wrap">
              <table className="table history-table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Slot</th>
                    <th>Výsledek</th>
                    <th>Progress</th>
                    <th>Tokeny (p/g)</th>
                    <th>Čas</th>
                    <th>tok/s (p/g)</th>
                    <th>Start</th>
                    <th>Konec</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((item) => (
                    <HistoryRow key={`${item.taskId}-${item.startedAt}`} item={item} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card dashboard-logs-section">
        <LogPanel compact fill title="Logy serve (live)" initialLimit={300} showClear={false} />
      </div>
    </div>
  )
}