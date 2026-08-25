import { useEffect, useState } from 'react'
import LoadedModelDetailsDialog from '../components/LoadedModelDetailsDialog'
import ModelSplitTable from '../components/ModelSplitTable'
import { useI18n } from '../i18n/I18nProvider'
import {
  api,
  type GpuAdapterInfo,
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

/** Procesy bez přiřazené karty (zdroj GPU nerozlišuje) mají vlastní sloupec. */
const UNKNOWN_ADAPTER = '\u0000unknown'

interface ProcessRow {
  pid: number
  processName: string
  source: GpuMemorySource | null
  /** VRAM podle klíče adaptéru */
  memByAdapter: Record<string, number>
  total: number
  /** true, když žádný zdroj hodnotu nevrátil (ne že by byla nula) */
  unknownMemory: boolean
}

/** Z řádků „proces × adaptér" udělá jeden řádek na proces se sloupcem pro každou kartu. */
function pivotProcesses(rows: GpuProcessInfo[]): ProcessRow[] {
  const byPid = new Map<number, ProcessRow>()
  for (const r of rows) {
    let row = byPid.get(r.pid)
    if (!row) {
      row = {
        pid: r.pid,
        processName: r.processName,
        source: r.source,
        memByAdapter: {},
        total: 0,
        unknownMemory: true
      }
      byPid.set(r.pid, row)
    }
    if (r.gpuMemoryMb == null) continue
    const key = r.adapterKey ?? UNKNOWN_ADAPTER
    row.memByAdapter[key] = (row.memByAdapter[key] ?? 0) + r.gpuMemoryMb
    row.total += r.gpuMemoryMb
    row.unknownMemory = false
    row.source = r.source
  }
  return [...byPid.values()]
}

type SortKey = 'pid' | 'name' | 'total' | string

function ProcessTable({
  rows,
  adapters,
  emptyLabel,
  baseFor,
  servePid,
  killingPid,
  onKill
}: {
  rows: GpuProcessInfo[]
  adapters: GpuAdapterInfo[]
  emptyLabel: string
  /** základ pro proužek podílu na daném adaptéru */
  baseFor: (adapterKey: string) => number | null
  servePid?: number | null
  killingPid?: number | null
  onKill?: (pid: number, processName: string) => void
}): JSX.Element {
  const { t, formatTinyShare } = useI18n()
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'total', desc: true })

  const sourceLabel = (source: GpuMemorySource | null): string => {
    const map: Record<GpuMemorySource, string> = {
      'perf-counter': t('resources.sourcePerfCounter'),
      'nvidia-smi': t('resources.sourceNvidiaSmi'),
      'process-list': t('resources.sourceProcessList')
    }
    return source ? map[source] : t('resources.unavailable')
  }

  const formatGpuMemory = (mb: number | undefined): string => {
    if (mb == null) return '—'
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

  const processRows = pivotProcesses(rows)
  const usedKeys = new Set(processRows.flatMap((r) => Object.keys(r.memByAdapter)))
  const columns = [
    ...adapters.filter((a) => usedKeys.has(a.key)).map((a) => ({ key: a.key, name: a.name })),
    ...(usedKeys.has(UNKNOWN_ADAPTER)
      ? [{ key: UNKNOWN_ADAPTER, name: t('resources.unknownAdapter') }]
      : [])
  ]
  // Bez jediné známé hodnoty ať tabulka pořád ukazuje aspoň jeden sloupec paměti
  const memoryColumns =
    columns.length > 0 ? columns : [{ key: UNKNOWN_ADAPTER, name: t('resources.colVram') }]
  const showTotal = memoryColumns.length > 1
  const canKill = typeof onKill === 'function'

  const valueOf = (row: ProcessRow, key: SortKey): number | string => {
    if (key === 'pid') return row.pid
    if (key === 'name') return row.processName.toLowerCase()
    if (key === 'total') return row.total
    return row.memByAdapter[key] ?? -1
  }

  const sorted = [...processRows].sort((a, b) => {
    const av = valueOf(a, sort.key)
    const bv = valueOf(b, sort.key)
    let cmp: number
    if (typeof av === 'string' || typeof bv === 'string') {
      cmp = String(av).localeCompare(String(bv))
    } else {
      cmp = av - bv
    }
    if (cmp === 0) cmp = a.pid - b.pid
    return sort.desc ? -cmp : cmp
  })

  const toggleSort = (key: SortKey): void => {
    setSort((current) =>
      current.key === key
        ? { key, desc: !current.desc }
        : // Paměť dává smysl od největší, jméno a PID od začátku
          { key, desc: key !== 'pid' && key !== 'name' }
    )
  }

  const SortableHeader = ({
    label,
    sortKey,
    align
  }: {
    label: string
    sortKey: SortKey
    align?: 'right'
  }): JSX.Element => (
    <th
      onClick={() => toggleSort(sortKey)}
      style={{ cursor: 'pointer', userSelect: 'none', textAlign: align }}
      title={t('resources.sortHint')}
      aria-sort={sort.key === sortKey ? (sort.desc ? 'descending' : 'ascending') : 'none'}
    >
      {label}
      <span className="metric-label" style={{ margin: '0 0 0 4px' }}>
        {sort.key === sortKey ? (sort.desc ? '▼' : '▲') : ''}
      </span>
    </th>
  )

  return (
    <table className="table">
      <thead>
        <tr>
          <SortableHeader label={t('resources.colPid')} sortKey="pid" />
          <SortableHeader label={t('resources.colProcess')} sortKey="name" />
          {memoryColumns.map((c) => (
            <SortableHeader key={c.key} label={c.name} sortKey={c.key} />
          ))}
          {showTotal && <SortableHeader label={t('resources.colTotal')} sortKey="total" />}
          <th>{t('resources.colSource')}</th>
          {canKill && <th aria-label={t('common.actions')} />}
        </tr>
      </thead>
      <tbody>
        {sorted.map((p) => {
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
              {memoryColumns.map((c) => {
                const mb = p.memByAdapter[c.key]
                const base = c.key === UNKNOWN_ADAPTER ? null : baseFor(c.key)
                const share = mb != null && base && base > 0 ? Math.min(100, (mb / base) * 100) : null
                return (
                  <td
                    key={c.key}
                    title={
                      share != null
                        ? t('resources.shareOfBase', {
                            share: formatTinyShare(share),
                            base: formatMb(base as number)
                          })
                        : undefined
                    }
                  >
                    {p.unknownMemory ? t('resources.unavailable') : formatGpuMemory(mb)}
                    {share != null && (
                      <div className="progress-bar" style={{ marginTop: 4 }}>
                        <div className="progress-fill" style={{ width: `${share}%` }} />
                      </div>
                    )}
                  </td>
                )
              })}
              {showTotal && <td>{p.unknownMemory ? '—' : formatMb(p.total)}</td>}
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

  const adapters = data?.adapters ?? []
  const adapterByKey = new Map(adapters.map((a) => [a.key, a]))

  const adaptersInUse = new Set(
    (data?.gpuProcesses ?? []).filter((p) => p.adapterKey).map((p) => p.adapterKey)
  ).size

  /** Součet per-proces VRAM na daném adaptéru */
  const adapterProcessSumMb = (key: string): number =>
    (data?.gpuProcesses ?? [])
      .filter((p) => p.adapterKey === key)
      .reduce((sum, p) => sum + (p.gpuMemoryMb ?? 0), 0)

  /**
   * Základ pro podíl procesu: kapacita adaptéru, pokud ji spotřeba nepřekračuje.
   * Integrovaná grafika hlásí jen symbolickou dedikovanou VRAM (128 MB), ale drží
   * paměť ve sdílené RAM — pak počítáme podíl z toho, co se na adaptéru používá.
   */
  const shareBaseFor = (adapterKey: string): number | null => {
    const adapter = adapterByKey.get(adapterKey)
    if (!adapter) return shareScaleMb
    const capacity = adapter.dedicatedTotalMb ?? 0
    const inUse = Math.max(adapterProcessSumMb(adapter.key), adapter.dedicatedUsedMb ?? 0)
    if (capacity > 0 && capacity >= inUse) return capacity
    return inUse > 0 ? inUse : shareScaleMb
  }

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
              <div className="metric-label">{t('resources.cpuLoadHint')}</div>
            </>
          )}
        </div>

        <div className="card">
          <div className="metric-label">{t('resources.processVramSum')}</div>
          <div className="metric-value">
            {perProcessTotal != null ? formatMb(perProcessTotal) : '—'}
          </div>
          <div className="metric-label">
            {!perProcessOk
              ? t('resources.sourceUnavailable')
              : adaptersInUse > 1
                ? t('resources.processCountAdapters', {
                    count: data?.gpuProcesses.length ?? 0,
                    adapters: adaptersInUse,
                    source: sourceLabel(perProcessSource)
                  })
                : t('resources.processCount', {
                    count: data?.gpuProcesses.length ?? 0,
                    source: sourceLabel(perProcessSource)
                  })}
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

      {adapters.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600 }}>
            {t('resources.adaptersTitle')}
          </h2>
          <p className="metric-label" style={{ margin: '0 0 12px' }}>
            {t('resources.adaptersHint')}
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>{t('resources.colGpu')}</th>
                <th>{t('resources.colDedicatedTotal')}</th>
                <th>{t('resources.colAdapterUsed')}</th>
                <th>{t('resources.colSharedUsed')}</th>
                <th>{t('resources.colProcessSum')}</th>
                <th>{t('resources.colUtilization')}</th>
              </tr>
            </thead>
            <tbody>
              {adapters.map((a) => {
                const processSum = adapterProcessSumMb(a.key)
                return (
                  <tr key={a.key}>
                    <td title={a.key}>
                      {a.name}
                      {a.nvidia?.index != null && (
                        <span className="metric-label" style={{ margin: '0 0 0 6px' }}>
                          nvidia-smi #{a.nvidia.index}
                        </span>
                      )}
                    </td>
                    <td>{a.dedicatedTotalMb != null ? formatMb(a.dedicatedTotalMb) : '—'}</td>
                    <td>{a.dedicatedUsedMb != null ? formatMb(a.dedicatedUsedMb) : '—'}</td>
                    <td>{a.sharedUsedMb != null ? formatMb(a.sharedUsedMb) : '—'}</td>
                    <td title={t('resources.processSumHint')}>
                      {processSum > 0 ? formatMb(processSum) : '—'}
                    </td>
                    <td>
                      {a.nvidia?.utilizationPercent != null
                        ? `${a.nvidia.utilizationPercent} %`
                        : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
          {t('resources.ollamaProcesses')}
        </h2>
        <ProcessTable
          rows={ollamaGpuProcs}
          adapters={adapters}
          emptyLabel={t('resources.ollamaEmpty')}
          baseFor={shareBaseFor}
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
            adapters={adapters}
            emptyLabel={t('resources.otherEmpty')}
            baseFor={shareBaseFor}
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
