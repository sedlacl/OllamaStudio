export interface ModelSplitRow {
  name: string
  /** celková paměť modelu (RAM+VRAM) z /api/ps `size` */
  size: number
  /** část na GPU z /api/ps `size_vram` */
  sizeVram: number
}

export interface ModelSplitTableProps {
  models: ModelSplitRow[]
  onDetails: (name: string) => void
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb.toFixed(0)} MB`
}

function formatBytes(bytes: number): string {
  return formatMb(bytes / (1024 * 1024))
}

function formatPercent(value: number): string {
  if (value > 0 && value < 0.1) return '<0,1 %'
  return `${value.toFixed(value < 10 ? 1 : 0)} %`
}

/** Dvojpruh znázorňující rozdělení modelu mezi GPU (VRAM) a CPU (RAM). */
function SplitBar({ gpuPercent }: { gpuPercent: number }): JSX.Element {
  const gpu = Math.max(0, Math.min(100, gpuPercent))
  return (
    <div
      className="progress-bar"
      style={{ marginTop: 4, display: 'flex' }}
      title={`GPU ${gpu.toFixed(0)} % · CPU ${(100 - gpu).toFixed(0)} %`}
    >
      <div className="progress-fill" style={{ width: `${gpu}%` }} />
      <div style={{ width: `${100 - gpu}%`, background: 'var(--warning)' }} />
    </div>
  )
}

/**
 * Rozpad modelu mezi GPU a CPU. Když /api/ps nevrátí `size`, bereme jako celek
 * samotnou VRAM — jinak by chybějící údaj vypadal jako 100 % na CPU.
 */
function splitOf(m: ModelSplitRow): {
  total: number
  vram: number
  ram: number
  gpuPercent: number | null
} {
  const total = m.size > 0 ? m.size : m.sizeVram
  const vram = Math.min(m.sizeVram, total)
  return {
    total,
    vram,
    ram: Math.max(0, total - vram),
    gpuPercent: total > 0 ? (vram / total) * 100 : null
  }
}

export default function ModelSplitTable({
  models,
  onDetails
}: ModelSplitTableProps): JSX.Element {
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Celkem</th>
            <th>Na GPU (VRAM)</th>
            <th>RAM (CPU)</th>
            <th style={{ width: '22%' }}>Rozložení GPU/CPU</th>
            <th aria-label="Akce" />
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const { total, vram, ram, gpuPercent } = splitOf(m)
            return (
              <tr key={m.name}>
                <td className="mono">{m.name}</td>
                <td>{total > 0 ? formatBytes(total) : '—'}</td>
                <td>
                  {vram > 0 ? formatBytes(vram) : '—'}
                  {gpuPercent != null && (
                    <span className="metric-label" style={{ margin: 0 }}>
                      {' '}
                      · {formatPercent(gpuPercent)}
                    </span>
                  )}
                </td>
                <td>
                  {ram > 0 ? formatBytes(ram) : '—'}
                  {gpuPercent != null && (
                    <span className="metric-label" style={{ margin: 0 }}>
                      {' '}
                      · {formatPercent(100 - gpuPercent)}
                    </span>
                  )}
                </td>
                <td>
                  {gpuPercent != null ? (
                    <SplitBar gpuPercent={gpuPercent} />
                  ) : (
                    <span className="metric-label" style={{ margin: 0 }}>
                      —
                    </span>
                  )}
                </td>
                <td className="table-actions">
                  <button
                    type="button"
                    className="btn btn-icon"
                    title="Zobrazit všechny parametry"
                    aria-label={`Parametry modelu ${m.name}`}
                    onClick={() => onDetails(m.name)}
                  >
                    …
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
        <span
          className="metric-label"
          style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--accent)' }} />
          GPU (VRAM)
        </span>
        <span
          className="metric-label"
          style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--warning)' }} />
          CPU (RAM)
        </span>
      </div>
    </>
  )
}
