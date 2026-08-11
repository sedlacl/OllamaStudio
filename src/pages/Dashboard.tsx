import { useEffect, useState } from 'react'
import { api, type DashboardData } from '../types/api'

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

export default function Dashboard(): JSX.Element {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)

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

      {data && data.loadedModels.length > 0 && (
        <div className="card">
          <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Načtené modely</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Název</th>
                <th>VRAM</th>
              </tr>
            </thead>
            <tbody>
              {data.loadedModels.map((m) => (
                <tr key={m.name}>
                  <td className="mono">{m.name}</td>
                  <td>{m.sizeVram ? formatMb(m.sizeVram / (1024 * 1024)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
