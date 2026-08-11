import { useEffect, useState } from 'react'
import LoadedModelDetailsDialog from '../components/LoadedModelDetailsDialog'
import {
  api,
  type ActiveRequest,
  type ActiveRequestPhase,
  type DashboardData
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

export default function Dashboard(): JSX.Element {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailsModel, setDetailsModel] = useState<string | null>(null)

  useEffect(() => {
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
    load()
    const id = setInterval(load, 2000)
    return () => clearInterval(id)
  }, [])

  if (loading && !data) {
    return <p className="empty-state">Načítání metrik…</p>
  }

  const gpu = data?.gpu
  const vramUsed = gpu ? gpu.memoryUsedMb : data?.vramFallbackMb
  const vramTotal = gpu?.memoryTotalMb ?? null
  const details = data?.activeRequestDetails ?? []

  return (
    <div>
      <h1 className="page-title">Přehled</h1>

      <div className="btn-row" style={{ marginBottom: 16 }}>
        <button className="btn btn-primary" onClick={() => api().startServer().catch(() => {})}>
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
  )
}
