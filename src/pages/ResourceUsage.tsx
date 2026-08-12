import { useEffect, useState } from 'react'
import LoadedModelDetailsDialog from '../components/LoadedModelDetailsDialog'
import ModelSplitTable from '../components/ModelSplitTable'
import { useI18n } from '../i18n/I18nProvider'
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

function ProcessTable({
  rows,
  emptyLabel,
  scaleMb,
  servePid,
  killingPid,
  onKill
}: {
  rows: GpuProcessInfo[]
  emptyLabel: string
  scaleMb: number | null
  servePid?: number | null
  killingPid?: number | null
  onKill?: (pid: number, processName: string) => void
}): JSX.Element {
  const { t, formatTinyShare } = useI18n()

  const sourceLabel = (source: GpuMemorySource | null): string => {
    const map: Record<GpuMemorySource, string> = {
      'perf-counter': t('resources.sourcePerfCounter'),
      'nvidia-smi': t('resources.sourceNvidiaSmi'),
      'process-list': t('resources.sourceProcessList')
    }
    return source ? map[source] : t('resources.unavailable')
  }

  const formatGpuMemory = (mb: number | null): string => {
    if (mb == null) return t('resources.unavailable')
    if (mb > 0 && mb < 1) return '<1 MB'
    return formatMb(mb)
  }

  if (rows.length === 0) {
    return (
      <p className="empty-state" style={{ padding: '8px 0' }}>
        {emptyLabel}
      </p>
    )
  }

  const canKill = typeof onKill === 'function'

  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t('resources.colPid')}</th>
          <th>{t('resources.colProcess')}</th>
          <th>{t('resources.colVram')}</th>
          <th style={{ width: '30%' }}>{t('resources.colShare')}</th>
          <th>{t('resources.colSource')}</th>
          {canKill && <th aria-label={t('common.actions')} />}
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const share =
            scaleMb && scaleMb > 0 && p.gpuMemoryMb != null
              ? (p.gpuMemoryMb / scaleMb) * 100
              : null
          const isServe = servePid != null && p.pid === servePid
          return (
            <tr key={p.pid}>
              <td className="mono">
                {p.pid}
                {isServe && (
                  <span className="metric-label" style={{ margin: '0 0 0 6px' }}>
                    serve
                  </span>
                )}
              </td>
              <td className="mono">{p.processName}</td>
              <td>{formatGpuMemory(p.gpuMemoryMb)}</td>
              <td>
                {share != null ? (
                  <>
                    <span className="mono" style={{ fontSize: 12 }}>
                      {formatTinyShare(share)} %
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
              {canKill && (
                <td className="table-actions">
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={killingPid === p.pid}
                    title={
                      isServe ? t('resources.killServeTitle') : t('resources.killProcessTitle')
                    }
                    onClick={() => onKill?.(p.pid, p.processName)}
                  >
                    {killingPid === p.pid ? '…' : t('resources.kill')}
                  </button>
                </td>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export default function ResourceUsage(): JSX.Element {
  const { t, formatTinyPercent } = useI18n()
  const [data, setData] = useState<ResourceUsageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailsModel, setDetailsModel] = useState<string | null>(null)
  const [killingPid, setKillingPid] = useState<number | null>(null)
  const [killError, setKillError] = useState<string | null>(null)
  const [killNotice, setKillNotice] = useState<string | null>(null)

  const sourceLabel = (source: GpuMemorySource | null): string => {
    const map: Record<GpuMemorySource, string> = {
      'perf-counter': t('resources.sourcePerfCounter'),
      'nvidia-smi': t('resources.sourceNvidiaSmi'),
      'process-list': t('resources.sourceProcessList')
    }
    return source ? map[source] : t('resources.unavailable')
  }

  const serveStatusLabel = (status: string): string => {
    const map: Record<string, string> = {
      running: t('status.running'),
      starting: t('status.starting'),
      stopping: t('status.stopping'),
      stopped: t('status.stopped'),
      error: t('status.error')
    }
    return map[status] ?? status
  }

  useEffect(() => {
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

  const refreshNow = async (): Promise<void> => {
    try {
      const d = await api().getResourceUsage()
      setData(d)
    } catch {
      /* ignore */
    }
  }

  const handleKill = async (pid: number, processName: string): Promise<void> => {
    const isServe = data?.serveMemory.pid === pid
    const label = isServe
      ? t('resources.killConfirmServe', { pid })
      : t('resources.killConfirmProcess', { name: processName, pid })
    if (!confirm(label)) return

    setKillingPid(pid)
    setKillError(null)
    setKillNotice(null)
    try {
      const result = await api().killOllamaProcess(pid)
      if (!result.ok) {
        setKillError(result.error ?? t('resources.killFailed'))
      } else {
        setKillNotice(
          isServe
            ? t('resources.killNoticeServe', { pid })
            : t('resources.killNoticeProcess', { name: processName, pid })
        )
        await refreshNow()
      }
    } catch (e) {
      setKillError(e instanceof Error ? e.message : t('resources.killFailed'))
    } finally {
      setKillingPid(null)
    }
  }

  if (loading && !data) {
    return <p className="empty-state">{t('resources.loading')}</p>
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
  const ollamaPids = new Set(ollamaGpuProcs.map((p) => p.pid))
  const otherGpuProcs =
    data?.gpuProcesses.filter((p) => !ollamaPids.has(p.pid) && p.pid !== servePid) ?? []

  const modelVramTotal =
    data?.loadedModels.reduce((sum, m) => sum + m.sizeVram, 0) ?? 0

  return (
    <div>
      <h1 className="page-title">{t('resources.title')}</h1>
      <p style={{ color: 'var(--text-muted)', margin: '0 0 16px' }}>
        {t('resources.subtitle', { seconds: REFRESH_MS / 1000 })}
      </p>

      {killNotice && <div className="alert alert-info">{killNotice}</div>}
      {killError && <div className="alert alert-error">{killError}</div>}

      {!data?.gpuAvailable && (
        <div className="alert alert-info" style={{ marginBottom: 16 }}>
          <strong>{t('resources.nvidiaMissingTitle')}</strong>
          {t('resources.nvidiaMissingBody')}
          {perProcessOk && (
            <span>
              {t('resources.nvidiaMissingPerProcess', { source: sourceLabel(perProcessSource) })}
            </span>
          )}
          {data && data.loadedModels.length > 0 && (
            <span>{t('resources.nvidiaMissingModels')}</span>
          )}
        </div>
      )}

      {perProcessSource === 'perf-counter' && (
        <div className="alert alert-info" style={{ marginBottom: 16 }}>
          <strong>{t('resources.perfCounterTitle')}</strong>
          {t('resources.perfCounterBody')}
        </div>
      )}

      {!perProcessOk && (
        <div className="alert alert-info" style={{ marginBottom: 16 }}>
          <strong>{t('resources.perProcessMissingTitle')}</strong>
          {t('resources.perProcessMissingBody')}
          {data && data.loadedModels.length > 0 && (
            <span>{t('resources.perProcessMissingModels')}</span>
          )}
        </div>
      )}

      <div className="card-grid">
        <div className="card">
          <div className="metric-label">{t('resources.serveStatus')}</div>
          <div className="metric-value">{serveStatusLabel(data?.serveStatus ?? '—')}</div>
        </div>

        <div className="card">
          <div className="metric-label">{t('resources.gpuVramTotal')}</div>
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
                {gpu.utilizationPercent != null
                  ? ` · ${t('resources.utilization', { pct: gpu.utilizationPercent })}`
                  : ''}
              </div>
            </>
          )}
          {!gpu && vramUsed != null && (
            <div className="metric-label">{t('resources.gpuEstimate')}</div>
          )}
        </div>

        <div className="card">
          <div className="metric-label">{t('resources.cpuLoad')}</div>
          <div className="metric-value">{formatTinyPercent(data?.cpu.usagePercent ?? null)}</div>
          {data?.cpu && (
            <>
              <div className="progress-bar" style={{ marginTop: 8 }}>
                <div
                  className="progress-fill"
                  style={{ width: `${Math.min(100, data.cpu.usagePercent ?? 0)}%` }}
                />
              </div>
              <div className="metric-label" style={{ marginTop: 6 }}>
                {data.cpu.model} · {t('resources.cores', { cores: data.cpu.cores })}
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div className="metric-label">{t('resources.processVramSum')}</div>
          <div className="metric-value">
            {perProcessTotal != null ? formatMb(perProcessTotal) : '—'}
          </div>
          <div className="metric-label">
            {perProcessOk
              ? t('resources.processCount', {
                  count: data?.gpuProcesses.length ?? 0,
                  source: sourceLabel(perProcessSource)
                })
              : t('resources.sourceUnavailable')}
          </div>
        </div>

        <div className="card">
          <div className="metric-label">
            {t('resources.loadedModelsVram')}
            {!perProcessOk && data && data.loadedModels.length > 0 ? ' (/api/ps)' : ''}
          </div>
          <div className="metric-value">
            {modelVramTotal > 0 ? formatBytes(modelVramTotal) : '—'}
          </div>
          <div className="metric-label">
            {t('resources.modelCount', { count: data?.loadedModels.length ?? 0 })}
          </div>
        </div>

        <div className="card">
          <div className="metric-label">{t('resources.serveRam')}</div>
          <div className="metric-value">
            {data?.serveMemory.workingSetMb ? formatMb(data.serveMemory.workingSetMb) : '—'}
          </div>
          {servePid && <div className="metric-label">PID {servePid}</div>}
        </div>

        <div className="card">
          <div className="metric-label">{t('resources.systemRam')}</div>
          <div className="metric-value">
            {data
              ? `${formatMb(data.systemMemory.usedMb)} / ${formatMb(data.systemMemory.totalMb)}`
              : '—'}
          </div>
          <div className="metric-label">
            {t('resources.free', { value: data ? formatMb(data.systemMemory.freeMb) : '—' })}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
          {t('resources.ollamaProcesses')}
        </h2>
        <ProcessTable
          rows={ollamaGpuProcs}
          emptyLabel={t('resources.ollamaEmpty')}
          scaleMb={shareScaleMb}
          servePid={servePid}
          killingPid={killingPid}
          onKill={(pid, name) => void handleKill(pid, name)}
        />
        {!perProcessOk && ollamaGpuProcs.length > 0 && (
          <p className="metric-label" style={{ marginTop: 8 }}>
            {t('resources.ollamaNoVramHint')}
          </p>
        )}
      </div>

      {perProcessOk && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
            {t('resources.otherApps')}
          </h2>
          <ProcessTable
            rows={otherGpuProcs}
            emptyLabel={t('resources.otherEmpty')}
            scaleMb={shareScaleMb}
          />
        </div>
      )}

      {data && data.loadedModels.length > 0 && (
        <div className="card">
          <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
            {t('resources.loadedSplit')}
          </h2>
          <p className="metric-label" style={{ margin: '0 0 12px' }}>
            {t('resources.loadedSplitHint')}
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
