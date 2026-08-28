import ModelOverflowMenu, { type OverflowAction } from './ModelOverflowMenu'
import { useModelSpeedTest } from './useModelSpeedTest'
import { useI18n } from '../i18n/I18nProvider'
import type { ModelSpeedTestResult } from '../types/api'

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
  /** Akce navíc do „…“ menu (např. Uvolnit na stránce Modely). */
  extraActions?: (name: string) => OverflowAction[]
  /** Zavolá se po dokončení testu rychlosti (refresh dat stránky). */
  onSpeedTestFinished?: () => void
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

/** TTFT / rychlost promptu / rychlost generování z posledního testu rychlosti. */
function SpeedCells({
  result,
  running
}: {
  result: ModelSpeedTestResult | null
  running: boolean
}): JSX.Element {
  const { t } = useI18n()

  if (running) {
    return (
      <>
        <td className="metric-label">…</td>
        <td className="metric-label">…</td>
        <td className="metric-label">…</td>
      </>
    )
  }

  if (!result) {
    const empty = (
      <span className="metric-label" style={{ margin: 0 }} title={t('speedTest.notMeasured')}>
        —
      </span>
    )
    return (
      <>
        <td>{empty}</td>
        <td>{empty}</td>
        <td>{empty}</td>
      </>
    )
  }

  return (
    <>
      <td title={t('speedTest.ttftHint')}>{result.ttftMs.toFixed(0)} ms</td>
      <td title={t('speedTest.promptSpeedHint', {
        tokens: result.promptTokens,
        ms: result.promptEvalMs.toFixed(0)
      })}>
        {result.promptTokensPerSecond.toFixed(1)} tok/s
      </td>
      <td title={t('speedTest.throughputHint', { tokens: result.generatedTokens })}>
        {result.tokensPerSecond.toFixed(1)} tok/s
      </td>
    </>
  )
}

export default function ModelSplitTable({
  models,
  onDetails,
  extraActions,
  onSpeedTestFinished
}: ModelSplitTableProps): JSX.Element {
  const { t, formatTinyPercent } = useI18n()
  const speedTest = useModelSpeedTest(onSpeedTestFinished)

  const actionsFor = (name: string): OverflowAction[] => [
    {
      id: 'details',
      label: t('splitTable.showParams'),
      onClick: () => onDetails(name)
    },
    {
      id: 'speed-test',
      label: speedTest.busyModel === name ? t('speedTest.running') : t('speedTest.action'),
      title: t('speedTest.actionTitle'),
      disabled: speedTest.busyModel !== null,
      onClick: () => speedTest.run(name)
    },
    ...(extraActions?.(name) ?? [])
  ]

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
            <th>{t('speedTest.colTtft')}</th>
            <th>{t('speedTest.colPrompt')}</th>
            <th>{t('speedTest.colResponse')}</th>
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
                <SpeedCells
                  result={speedTest.resultFor(m.name)}
                  running={speedTest.busyModel === m.name}
                />
                <td className="table-actions">
                  <ModelOverflowMenu modelName={m.name} actions={actionsFor(m.name)} />
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
      {speedTest.dialog}
    </>
  )
}
