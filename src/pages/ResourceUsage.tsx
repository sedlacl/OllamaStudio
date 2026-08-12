import { useEffect, useState } from 'react'
import LoadedModelDetailsDialog from '../components/LoadedModelDetailsDialog'
import { api, type GpuProcessInfo, type ResourceUsageData } from '../types/api'

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb.toFixed(0)} MB`
}

function formatBytes(bytes: number): string {
  return formatMb(bytes / (1024 * 1024))
}

function formatGpuMemory(mb: number | null): string {
  if (mb == null) return 'nedostupné'
  return formatMb(mb)
}

function serveStatusLabel(status: string): string {
  const map: Record<string, string> = {
    running: 'Běží',
    starting: 'Spouští se',
    stopping: 'Zastavuje se',
    stopped: 'Zastaveno',
    error: 'Chyba'
  }
  return map[status] ?? status
}

function ProcessTable({
  rows,
  emptyLabel
}: {
  rows: GpuProcessInfo[]
  emptyLabel: string
}): JSX.Element {
  if (rows.length === 0) {
    return (
      <p className="empty-state" style={{ padding: '8px 0' }}>
        {emptyLabel}
      </p>
    )
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>PID</th>
          <th>Proces</th>
          <th>VRAM</th>
          <th>Zdroj</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.pid}>
            <td className="mono">{p.pid}</td>
            <td className="mono">{p.processName}</td>
            <td>{formatGpuMemory(p.gpuMemoryMb)}</td>
            <td className="metric-label" style={{ margin: 0 }}>
              {p.source === 'nvidia-smi' ? 'nvidia-smi' : 'procesy'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function ResourceUsage(): JSX.Element {
  const [data, setData] = useState<ResourceUsageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailsModel, setDetailsModel] = useState<string | null>(null)

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const d = await api().getResourceUsage()
        setData(d)
      } catch {
        /* server may be down */
      } finally {
        setLoading(false)
      }
    }

    void load()
    const pollId = setInterval(load, 2000)
    return () => clearInterval(pollId)
  }, [])

  if (loading && !data) {
    return <p className="empty-state">Načítání využití zdrojů…</p>
  }

  const gpu = data?.gpu
  const vramUsed = gpu ? gpu.memoryUsedMb : data?.vramFallbackMb
  const vramTotal = gpu?.memoryTotalMb ?? null
  const servePid = data?.serveMemory.pid ?? null
  const perProcessOk = data?.perProcessVramAvailable ?? false

  const ollamaGpuProcs = data?.ollamaProcesses ?? []

  // Pouze skuteční spotřebitelé se známou VRAM; Ollama řádky už jsou v sekci výše
  const ollamaPids = new Set(ollamaGpuProcs.map((p) => p.pid))
  const otherGpuProcs =
    data?.gpuProcesses.filter((p) => !ollamaPids.has(p.pid) && p.pid !== servePid) ?? []

  const modelVramTotal =
    data?.loadedModels.reduce((sum, m) => sum + m.sizeVram, 0) ?? 0

  return (
    <div>
      <h1 className="page-title">GPU a paměť</h1>
      <p style={{ color: 'var(--text-muted)', margin: '0 0 16px' }}>
        Kdo a co využívá GPU VRAM a systémovou paměť související s Ollama serve a načtenými modely.
        Obnovuje se každé 2 s.
      </p>

      {!data?.gpuAvailable && (
        <div className="alert alert-info" style={{ marginBottom: 16 }}>
          <strong>nvidia-smi není dostupné</strong> — GPU metriky a seznam procesů na GPU se nezobrazí.
          {data && data.loadedModels.length > 0 && (
            <span>
              {' '}
              VRAM u načtených modelů je odhad z Ollama <code>/api/ps</code> (pole{' '}
              <code>size_vram</code>).
            </span>
          )}
        </div>
      )}

      {data?.gpuAvailable && !perProcessOk && (
        <div className="alert alert-info" style={{ marginBottom: 16 }}>
          <strong>Per-proces VRAM není dostupné</strong> — na Windows v režimu WDDM nvidia-smi vrací
          pro procesy <code>[N/A]</code> (paměť spravuje KMD, ne NVIDIA driver). Celková VRAM GPU
          výše je spolehlivá; u jednotlivých procesů nezobrazujeme falešné 0&nbsp;MB.
          {data.loadedModels.length > 0 && (
            <span>
              {' '}
              VRAM načtených modelů bereme z Ollama <code>/api/ps</code> (
              <code>size_vram</code>).
            </span>
          )}
        </div>
      )}

      <div className="card-grid">
        <div className="card">
          <div className="metric-label">Stav serve</div>
          <div className="metric-value">{serveStatusLabel(data?.serveStatus ?? '—')}</div>
        </div>

        <div className="card">
          <div className="metric-label">GPU / VRAM celkem</div>
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
              {gpu.utilizationPercent != null ? ` · vytížení ${gpu.utilizationPercent} %` : ''}
            </div>
          )}
          {!gpu && vramUsed != null && (
            <div className="metric-label">Odhad z /api/ps (nvidia-smi nedostupné)</div>
          )}
        </div>

        <div className="card">
          <div className="metric-label">
            VRAM načtených modelů
            {!perProcessOk && data && data.loadedModels.length > 0 ? ' (/api/ps)' : ''}
          </div>
          <div className="metric-value">
            {modelVramTotal > 0 ? formatBytes(modelVramTotal) : '—'}
          </div>
          <div className="metric-label">{data?.loadedModels.length ?? 0} model(ů)</div>
        </div>

        <div className="card">
          <div className="metric-label">RAM procesu serve (Working Set)</div>
          <div className="metric-value">
            {data?.serveMemory.workingSetMb ? formatMb(data.serveMemory.workingSetMb) : '—'}
          </div>
          {servePid && <div className="metric-label">PID {servePid}</div>}
        </div>

        <div className="card">
          <div className="metric-label">Systémová RAM (použito / celkem)</div>
          <div className="metric-value">
            {data
              ? `${formatMb(data.systemMemory.usedMb)} / ${formatMb(data.systemMemory.totalMb)}`
              : '—'}
          </div>
          <div className="metric-label">
            Volno {data ? formatMb(data.systemMemory.freeMb) : '—'}
          </div>
        </div>
      </div>

      {data?.gpuAvailable && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
              Procesy Ollama / llama runner
            </h2>
            <ProcessTable
              rows={ollamaGpuProcs}
              emptyLabel="Žádný proces Ollama / runner (serve neběží, nebo nebyl nalezen)"
            />
            {!perProcessOk && ollamaGpuProcs.length > 0 && (
              <p className="metric-label" style={{ marginTop: 8 }}>
                VRAM u jednotlivých PID je na WDDM nedostupná — použijte kartu „VRAM načtených
                modelů“ výše (/api/ps).
              </p>
            )}
          </div>

          {perProcessOk && (
            <div className="card" style={{ marginBottom: 16 }}>
              <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
                Ostatní procesy na GPU (skutečná VRAM)
              </h2>
              <ProcessTable
                rows={otherGpuProcs}
                emptyLabel="Žádné další procesy se známou VRAM"
              />
            </div>
          )}
        </>
      )}

      {data && data.loadedModels.length > 0 && (
        <div className="card">
          <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
            Načtené modely
            {!perProcessOk ? ' — VRAM z /api/ps' : ''}
          </h2>
          <table className="table">
            <thead>
              <tr>
                <th>Model</th>
                <th>VRAM</th>
                <th>Velikost na disku</th>
                <th aria-label="Akce" />
              </tr>
            </thead>
            <tbody>
              {data.loadedModels.map((m) => (
                <tr key={m.name}>
                  <td className="mono">{m.name}</td>
                  <td>{m.sizeVram ? formatBytes(m.sizeVram) : '—'}</td>
                  <td>{m.size ? formatBytes(m.size) : '—'}</td>
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
