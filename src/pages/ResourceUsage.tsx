import { useEffect, useState } from 'react'
import LoadedModelDetailsDialog from '../components/LoadedModelDetailsDialog'
import ModelSplitTable from '../components/ModelSplitTable'
import {
  api,
  type GpuMemorySource,
  type GpuProcessInfo,
  type ResourceUsageData
} from '../types/api'

const REFRESH_MS = 8000

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb.toFixed(0)} MB`
}

function formatBytes(bytes: number): string {
  return formatMb(bytes / (1024 * 1024))
}

function formatGpuMemory(mb: number | null): string {
  if (mb == null) return 'nedostupné'
  if (mb > 0 && mb < 1) return '<1 MB'
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

function sourceLabel(source: GpuMemorySource | null): string {
  const map: Record<GpuMemorySource, string> = {
    'perf-counter': 'čítače Windows',
    'nvidia-smi': 'nvidia-smi',
    'process-list': 'seznam procesů'
  }
  return source ? map[source] : 'nedostupné'
}

function formatPercent(value: number | null): string {
  if (value == null) return '—'
  if (value > 0 && value < 0.1) return '<0,1 %'
  return `${value.toFixed(value < 10 ? 1 : 0)} %`
}

function ProcessTable({
  rows,
  emptyLabel,
  scaleMb
}: {
  rows: GpuProcessInfo[]
  emptyLabel: string
  /** základ pro sloupec podílu — celková VRAM GPU, případně součet procesů */
  scaleMb: number | null
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
          <th style={{ width: '30%' }}>Podíl</th>
          <th>Zdroj</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const share =
            scaleMb && scaleMb > 0 && p.gpuMemoryMb != null
              ? (p.gpuMemoryMb / scaleMb) * 100
              : null
          return (
            <tr key={p.pid}>
              <td className="mono">{p.pid}</td>
              <td className="mono">{p.processName}</td>
              <td>{formatGpuMemory(p.gpuMemoryMb)}</td>
              <td>
                {share != null ? (
                  <>
                    <span className="mono" style={{ fontSize: 12 }}>
                      {share < 0.1 ? '<0,1' : share.toFixed(1)} %
                    </span>
                    <div className="progress-bar" style={{ marginTop: 4 }}>
                      <div
                        className="progress-fill"
                        style={{ width: `${Math.min(100, share)}%` }}
                      />
                    </div>
                  </>
                ) : (
                  <span className="metric-label" style={{ margin: 0 }}>
                    —
                  </span>
                )}
              </td>
              <td className="metric-label" style={{ margin: 0 }}>
                {sourceLabel(p.source)}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export default function ResourceUsage(): JSX.Element {
  const [data, setData] = useState<ResourceUsageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailsModel, setDetailsModel] = useState<string | null>(null)

  useEffect(() => {
    // Čtení výkonnostních čítačů trvá ~2 s, takže dotazy nesmí běžet přes sebe
    let inFlight = false
    let cancelled = false

    const load = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const d = await api().getResourceUsage()
        if (!cancelled) setData(d)
      } catch {
        /* server may be down */
      } finally {
        inFlight = false
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    const pollId = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(pollId)
    }
  }, [])

  if (loading && !data) {
    return <p className="empty-state">Načítání využití zdrojů…</p>
  }

  const gpu = data?.gpu
  const vramUsed = gpu ? gpu.memoryUsedMb : data?.vramFallbackMb
  const vramTotal = gpu?.memoryTotalMb ?? null
  const servePid = data?.serveMemory.pid ?? null
  const perProcessOk = data?.perProcessVramAvailable ?? false
  const perProcessSource = data?.perProcessSource ?? null
  const perProcessTotal = data?.perProcessVramTotalMb ?? null
  const shareScaleMb = vramTotal ?? perProcessTotal

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
        Kdo a co využívá GPU VRAM a systémovou paměť — včetně aplikací mimo Ollama. Obnovuje se
        každých {REFRESH_MS / 1000} s.
      </p>

      {!data?.gpuAvailable && (
        <div className="alert alert-info" style={{ marginBottom: 16 }}>
          <strong>nvidia-smi není dostupné</strong> — souhrnné metriky GPU (název, celková VRAM,
          vytížení) se nezobrazí.
          {perProcessOk && <span> Per-proces VRAM se čte z {sourceLabel(perProcessSource)}.</span>}
          {data && data.loadedModels.length > 0 && (
            <span>
              {' '}
              VRAM u načtených modelů je odhad z Ollama <code>/api/ps</code> (pole{' '}
              <code>size_vram</code>).
            </span>
          )}
        </div>
      )}

      {perProcessSource === 'perf-counter' && (
        <div className="alert alert-info" style={{ marginBottom: 16 }}>
          <strong>Per-proces VRAM z výkonnostních čítačů Windows</strong> — čítač{' '}
          <code>\GPU Process Memory(pid_*)\Dedicated Usage</code>. Na Windows v režimu WDDM vrací
          nvidia-smi u procesů <code>[N/A]</code>, protože paměť spravuje KMD, ne NVIDIA driver.
          Součet přes procesy se může od celkové VRAM GPU lišit (sdílené a driverové alokace).
        </div>
      )}

      {!perProcessOk && (
        <div className="alert alert-info" style={{ marginBottom: 16 }}>
          <strong>Per-proces VRAM není dostupné</strong> — nvidia-smi vrací pro procesy{' '}
          <code>[N/A]</code> a výkonnostní čítače GPU se nepodařilo přečíst. U jednotlivých procesů
          nezobrazujeme falešné 0&nbsp;MB.
          {data && data.loadedModels.length > 0 && (
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
            <>
              {gpu.utilizationPercent != null && (
                <div className="progress-bar" style={{ marginTop: 8 }}>
                  <div
                    className="progress-fill"
                    style={{ width: `${Math.min(100, gpu.utilizationPercent)}%` }}
                  />
                </div>
              )}
              <div className="metric-label" style={{ marginTop: 6 }}>
                {gpu.name}
                {gpu.utilizationPercent != null ? ` · vytížení ${gpu.utilizationPercent} %` : ''}
              </div>
            </>
          )}
          {!gpu && vramUsed != null && (
            <div className="metric-label">Odhad z /api/ps (nvidia-smi nedostupné)</div>
          )}
        </div>

        <div className="card">
          <div className="metric-label">CPU zátěž</div>
          <div className="metric-value">{formatPercent(data?.cpu.usagePercent ?? null)}</div>
          {data?.cpu && (
            <>
              <div className="progress-bar" style={{ marginTop: 8 }}>
                <div
                  className="progress-fill"
                  style={{ width: `${Math.min(100, data.cpu.usagePercent ?? 0)}%` }}
                />
              </div>
              <div className="metric-label" style={{ marginTop: 6 }}>
                {data.cpu.model} · {data.cpu.cores} jader
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div className="metric-label">Součet VRAM procesů</div>
          <div className="metric-value">
            {perProcessTotal != null ? formatMb(perProcessTotal) : '—'}
          </div>
          <div className="metric-label">
            {perProcessOk
              ? `${data?.gpuProcesses.length ?? 0} procesů · ${sourceLabel(perProcessSource)}`
              : 'zdroj nedostupný'}
          </div>
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

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
          Procesy Ollama / llama runner
        </h2>
        <ProcessTable
          rows={ollamaGpuProcs}
          emptyLabel="Žádný proces Ollama / runner (serve neběží, nebo nebyl nalezen)"
          scaleMb={shareScaleMb}
        />
        {!perProcessOk && ollamaGpuProcs.length > 0 && (
          <p className="metric-label" style={{ marginTop: 8 }}>
            VRAM u jednotlivých PID není z žádného zdroje dostupná — použijte kartu „VRAM načtených
            modelů“ výše (/api/ps).
          </p>
        )}
      </div>

      {perProcessOk && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
            Ostatní aplikace využívající VRAM
          </h2>
          <ProcessTable
            rows={otherGpuProcs}
            emptyLabel="Žádné další procesy se známou VRAM"
            scaleMb={shareScaleMb}
          />
        </div>
      )}

      {data && data.loadedModels.length > 0 && (
        <div className="card">
          <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
            Načtené modely — rozložení CPU / GPU
          </h2>
          <p className="metric-label" style={{ margin: '0 0 12px' }}>
            Zdroj Ollama <code>/api/ps</code>: <code>size</code> je celková paměť modelu (RAM+VRAM),{' '}
            <code>size_vram</code> část na GPU. Zbytek běží na CPU — proto se „na GPU“ a „celkem“
            liší.
          </p>
          <ModelSplitTable models={data.loadedModels} onDetails={setDetailsModel} />
        </div>
      )}

      {detailsModel && (
        <LoadedModelDetailsDialog modelName={detailsModel} onClose={() => setDetailsModel(null)} />
      )}
    </div>
  )
}
