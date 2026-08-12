import { useEffect, useState } from 'react'
import LoadedModelDetailsDialog from '../components/LoadedModelDetailsDialog'
import LogPanel from '../components/LogPanel'
import ModelSplitTable from '../components/ModelSplitTable'
import { useI18n } from '../i18n/I18nProvider'
import {
  api,
  type ActiveRequest,
  type ActiveRequestPhase,
  type DashboardData,
  type ModelLoadState,
  type RequestHistoryItem,
  type RequestHistoryResult,
  type RequestKind
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

function formatElapsed(seconds: number | null): string {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s.toFixed(0)}s`
}

function ActiveRequestCard({ req }: { req: ActiveRequest }): JSX.Element {
  const { t, formatNumber } = useI18n()
  const showBar = req.progressPercent != null
  const pct = showBar ? Math.min(100, Math.max(0, req.progressPercent!)) : null

  const phaseLabel = (phase: ActiveRequestPhase): string => {
    const map: Record<ActiveRequestPhase, string> = {
      prompt_processing: t('dashboard.phasePrompt'),
      generation: t('dashboard.phaseGeneration'),
      caching: t('dashboard.phaseCaching'),
      done: t('dashboard.phaseDone'),
      unknown: t('dashboard.phaseUnknown')
    }
    return map[phase]
  }

  const kindLabel = (kind: RequestKind | null): string => {
    if (kind == null) return '—'
    const map: Record<RequestKind, string> = {
      chat: t('dashboard.kindChat'),
      generate: t('dashboard.kindGenerate'),
      embed: t('dashboard.kindEmbed')
    }
    return map[kind]
  }

  return (
    <div className={`active-req ${req.status === 'completed' ? 'active-req-done' : ''}`}>
      <div className="active-req-header">
        <div className="active-req-ids">
          <span className="mono">task {req.taskId}</span>
          {req.slotId != null && <span className="mono">slot {req.slotId}</span>}
        </div>
        <div className="active-req-ids">
          {req.kind && <span className="history-kind">{kindLabel(req.kind)}</span>}
          <span className="active-req-phase">{phaseLabel(req.phase)}</span>
        </div>
      </div>

      {showBar && (
        <div className="progress-bar active-req-bar">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}

      <div className="active-req-metrics">
        <div>
          <div className="metric-label">{t('dashboard.progress')}</div>
          <div className="active-req-value">
            {pct != null ? `${pct.toFixed(0)} %` : '—'}
          </div>
        </div>
        <div>
          <div className="metric-label">{t('dashboard.tokens')}</div>
          <div className="active-req-value">
            {req.nTokens != null ? formatNumber(req.nTokens) : '—'}
          </div>
        </div>
        <div>
          <div className="metric-label">{t('dashboard.time')}</div>
          <div className="active-req-value">{formatElapsed(req.elapsedSeconds)}</div>
        </div>
        <div>
          <div className="metric-label">{t('dashboard.tokensPerSec')}</div>
          <div className="active-req-value">
            {req.tokensPerSec != null ? req.tokensPerSec.toFixed(1) : '—'}
          </div>
        </div>
      </div>
    </div>
  )
}

function ActiveRequestPlaceholder(): JSX.Element {
  const { t } = useI18n()
  return (
    <div className="active-req active-req-idle" aria-live="polite">
      <div className="active-req-header">
        <div className="active-req-ids">
          <span className="mono">task —</span>
          <span className="mono">slot —</span>
        </div>
        <span className="active-req-phase active-req-phase-idle">{t('dashboard.waiting')}</span>
      </div>
      <div className="progress-bar active-req-bar">
        <div className="progress-fill" style={{ width: '0%' }} />
      </div>
      <div className="active-req-metrics">
        <div>
          <div className="metric-label">{t('dashboard.progress')}</div>
          <div className="active-req-value">—</div>
        </div>
        <div>
          <div className="metric-label">{t('dashboard.tokens')}</div>
          <div className="active-req-value">—</div>
        </div>
        <div>
          <div className="metric-label">{t('dashboard.time')}</div>
          <div className="active-req-value">—</div>
        </div>
        <div>
          <div className="metric-label">{t('dashboard.tokensPerSec')}</div>
          <div className="active-req-value">—</div>
        </div>
      </div>
      <p className="active-req-idle-label">{t('dashboard.noActiveRequest')}</p>
    </div>
  )
}

function HistoryRow({ item }: { item: RequestHistoryItem }): JSX.Element {
  const { t, formatNumber, formatTime } = useI18n()
  const resultClass =
    item.result === 'done' ? 'history-result-done' : 'history-result-stale'

  const phaseLabel = (phase: ActiveRequestPhase): string => {
    const map: Record<ActiveRequestPhase, string> = {
      prompt_processing: t('dashboard.phasePrompt'),
      generation: t('dashboard.phaseGeneration'),
      caching: t('dashboard.phaseCaching'),
      done: t('dashboard.phaseDone'),
      unknown: t('dashboard.phaseUnknown')
    }
    return map[phase]
  }

  const kindLabel = (kind: RequestKind | null): string => {
    if (kind == null) return '—'
    const map: Record<RequestKind, string> = {
      chat: t('dashboard.kindChat'),
      generate: t('dashboard.kindGenerate'),
      embed: t('dashboard.kindEmbed')
    }
    return map[kind]
  }

  const resultLabel = (result: RequestHistoryResult): string =>
    result === 'done' ? t('dashboard.resultDone') : t('dashboard.resultStale')

  const formatTokenPair = (prompt: number | null, generation: number | null): string => {
    if (prompt == null && generation == null) return '—'
    const p = prompt != null ? formatNumber(prompt) : '—'
    const g = generation != null ? formatNumber(generation) : '—'
    return `${p} / ${g}`
  }

  const formatTpsPair = (prompt: number | null, generation: number | null): string => {
    if (prompt == null && generation == null) return '—'
    const p = prompt != null ? prompt.toFixed(1) : '—'
    const g = generation != null ? generation.toFixed(1) : '—'
    return `${p} / ${g}`
  }

  const reason =
    item.completionReason ??
    (item.phase && item.phase !== 'done' ? phaseLabel(item.phase) : null)

  return (
    <tr>
      <td className="mono">{item.taskId}</td>
      <td className="mono">{item.slotId != null ? item.slotId : '—'}</td>
      <td>
        {item.kind ? (
          <span className="history-kind">{kindLabel(item.kind)}</span>
        ) : (
          '—'
        )}
      </td>
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
      <td className="mono">{formatTime(item.startedAt)}</td>
      <td className="mono">{formatTime(item.completedAt)}</td>
    </tr>
  )
}

export default function Dashboard(): JSX.Element {
  const { t } = useI18n()
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

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

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
    const pollId = setInterval(load, 5000)
    const unsubRequests = api().subscribeDashboardRequests(scheduleRefresh)

    return () => {
      clearInterval(pollId)
      if (debounceTimer) clearTimeout(debounceTimer)
      unsubRequests()
    }
  }, [])

  const connectionLabel = (c: string): string => {
    const map: Record<string, string> = {
      connected: t('connection.connected'),
      disconnected: t('connection.disconnected'),
      starting: t('connection.starting'),
      error: t('connection.error')
    }
    return map[c] ?? c
  }

  if (loading && !data) {
    return (
      <div className="dashboard-page">
        <p className="empty-state">{t('dashboard.loadingMetrics')}</p>
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
        <h1 className="page-title">{t('dashboard.title')}</h1>

        {activeModelLoads.length > 0 && (
          <div className="alert alert-info" style={{ marginBottom: 16 }}>
            {t('dashboard.loadingModelsBg')}{' '}
            {activeModelLoads.map((s) => (
              <span key={s.name} className="mono">
                {s.name}
              </span>
            ))}
            {t('dashboard.loadingModelsHint')}
          </div>
        )}

        {failedModelLoads.map((s) => (
          <div key={s.name} className="alert alert-error" style={{ marginBottom: 16 }}>
            {t('dashboard.loadFailed', { name: s.name, error: s.error ?? '' })}
          </div>
        ))}

        <div className="btn-row" style={{ marginBottom: 16 }}>
          <button className="btn btn-primary" onClick={() => api().startServer().catch(() => {})}>
            {t('dashboard.startServe')}
          </button>
          <button className="btn" onClick={() => api().stopServer().catch(() => {})}>
            {t('dashboard.stopServe')}
          </button>
          <button className="btn" onClick={() => api().restartServer().catch(() => {})}>
            {t('dashboard.restartServe')}
          </button>
        </div>

        <div className="card-grid">
          <div className="card">
            <div className="metric-label">{t('dashboard.apiStatus')}</div>
            <div className="metric-value">{data ? connectionLabel(data.connection) : '—'}</div>
            {data?.version && (
              <div className="metric-label">{t('dashboard.version', { version: data.version })}</div>
            )}
          </div>

          <div className="card">
            <div className="metric-label">{t('dashboard.gpuVram')}</div>
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
              <div className="metric-label">{t('dashboard.gpuEstimate')}</div>
            )}
          </div>

          <div className="card">
            <div className="metric-label">{t('dashboard.loadedModels')}</div>
            <div className="metric-value">{data?.loadedCount ?? 0}</div>
          </div>

          <div className="card">
            <div className="metric-label">{t('dashboard.serveMemory')}</div>
            <div className="metric-value">
              {data?.memory.workingSetMb ? formatMb(data.memory.workingSetMb) : '—'}
            </div>
            {data?.memory.pid && <div className="metric-label">PID {data.memory.pid}</div>}
          </div>

          <div className="card">
            <div className="metric-label">{t('dashboard.activeRequests')}</div>
            <div className="metric-value">
              {data?.activeRequests != null ? data.activeRequests : '—'}
            </div>
            <div className="metric-label">{t('dashboard.estimateFromLogs')}</div>
          </div>

          <div className="card">
            <div className="metric-label">{t('dashboard.tokensPerSec')}</div>
            <div className="metric-value">
              {data?.tokensPerSec != null ? data.tokensPerSec.toFixed(1) : '—'}
            </div>
            <div className="metric-label">{t('dashboard.rollingAvg')}</div>
          </div>

          <div className="card">
            <div className="metric-label">{t('dashboard.uptime')}</div>
            <div className="metric-value">{formatUptime(data?.uptimeSeconds ?? null)}</div>
          </div>
        </div>

        {data && data.loadedModels.length > 0 && (
          <div className="card">
            <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
              {t('dashboard.loadedSplit')}
            </h2>
            <ModelSplitTable models={data.loadedModels} onDetails={setDetailsModel} />
          </div>
        )}

        {detailsModel && (
          <LoadedModelDetailsDialog modelName={detailsModel} onClose={() => setDetailsModel(null)} />
        )}
      </div>

      <div className="card dashboard-activity-section">
        <div className="active-req-section-header">
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{t('dashboard.activity')}</h2>
          <span className="metric-label" style={{ margin: 0 }}>
            {t('dashboard.activityHint')}
          </span>
        </div>

        <div className="active-req-list">
          {details.length === 0 ? (
            <ActiveRequestPlaceholder />
          ) : (
            details.map((req) => <ActiveRequestCard key={req.taskId} req={req} />)
          )}
        </div>

        <h3 className="activity-history-title">{t('dashboard.history')}</h3>
        <div className="dashboard-history-body">
          {history.length === 0 ? (
            <p className="history-empty">{t('dashboard.historyEmpty')}</p>
          ) : (
            <div className="history-table-wrap">
              <table className="table history-table">
                <thead>
                  <tr>
                    <th>{t('dashboard.colTask')}</th>
                    <th>{t('dashboard.colSlot')}</th>
                    <th>{t('dashboard.colType')}</th>
                    <th>{t('dashboard.colResult')}</th>
                    <th>{t('dashboard.colProgress')}</th>
                    <th>{t('dashboard.colTokens')}</th>
                    <th>{t('dashboard.colTime')}</th>
                    <th>{t('dashboard.colTps')}</th>
                    <th>{t('dashboard.colStart')}</th>
                    <th>{t('dashboard.colEnd')}</th>
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
        <LogPanel
          compact
          fill
          title={t('dashboard.logsLive')}
          initialLimit={300}
          showClear={false}
        />
      </div>
    </div>
  )
}
