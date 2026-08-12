import { useI18n } from '../i18n/I18nProvider'

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

function SplitBar({ gpuPercent }: { gpuPercent: number }): JSX.Element {
  const { t } = useI18n()
  const gpu = Math.max(0, Math.min(100, gpuPercent))
  return (
    <div
      className="progress-bar"
      style={{ marginTop: 4, display: 'flex' }}
      title={t('splitTable.barTitle', {
        gpu: gpu.toFixed(0),
        cpu: (100 - gpu).toFixed(0)
      })}
    >
      <div className="progress-fill" style={{ width: `${gpu}%` }} />
      <div style={{ width: `${100 - gpu}%`, background: 'var(--warning)' }} />
    </div>
  )
}

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
  const { t, formatTinyPercent } = useI18n()

  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>{t('splitTable.model')}</th>
            <th>{t('splitTable.total')}</th>
            <th>{t('splitTable.onGpu')}</th>
            <th>{t('splitTable.ramCpu')}</th>
            <th style={{ width: '22%' }}>{t('splitTable.distribution')}</th>
            <th aria-label={t('common.actions')} />
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
                      · {formatTinyPercent(gpuPercent)}
                    </span>
                  )}
                </td>
                <td>
                  {ram > 0 ? formatBytes(ram) : '—'}
                  {gpuPercent != null && (
                    <span className="metric-label" style={{ margin: 0 }}>
                      {' '}
                      · {formatTinyPercent(100 - gpuPercent)}
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
                    title={t('splitTable.showParams')}
                    aria-label={t('splitTable.modelParamsAria', { name: m.name })}
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
          {t('splitTable.gpuVram')}
        </span>
        <span
          className="metric-label"
          style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--warning)' }} />
          {t('splitTable.cpuRam')}
        </span>
      </div>
    </>
  )
}
