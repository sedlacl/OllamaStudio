import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { api, type LogEntry } from '../types/api'

type FilterCategory = 'filtered' | 'all' | 'error' | 'load' | 'request'

const FILTER_STORAGE_KEY = 'ollamastudio.logFilter'

/** GIN access-log řádky z pollingu OllamaStudio (`GET "/api/ps"`, `GET "/api/version"`). */
const STUDIO_POLL_RE = /\bGET\s+"\/api\/(?:ps|version)(?:\?[^"]*)?"/

function isFilterCategory(value: string): value is FilterCategory {
  return (
    value === 'filtered' ||
    value === 'all' ||
    value === 'error' ||
    value === 'load' ||
    value === 'request'
  )
}

function readStoredFilter(): FilterCategory {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY)
    if (raw === 'unload') return 'load'
    if (raw && isFilterCategory(raw)) return raw
  } catch {
    /* private mode / unavailable storage */
  }
  return 'filtered'
}

function writeStoredFilter(category: FilterCategory): void {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, category)
  } catch {
    /* ignore quota / private mode */
  }
}

function isStudioPollNoise(text: string): boolean {
  return STUDIO_POLL_RE.test(text)
}

function matchesCategory(entry: LogEntry, category: FilterCategory): boolean {
  if (category === 'filtered') return !isStudioPollNoise(entry.text)
  if (category === 'all') return true
  if (category === 'load') return entry.category === 'load' || entry.category === 'unload'
  return entry.category === category
}

export interface LogPanelProps {
  compact?: boolean
  fill?: boolean
  maxHeight?: number
  showClear?: boolean
  initialLimit?: number
  title?: string
}

export default function LogPanel({
  compact = false,
  fill = false,
  maxHeight,
  showClear = true,
  initialLimit = 1000,
  title
}: LogPanelProps): JSX.Element {
  const { t, formatTime } = useI18n()
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [textFilter, setTextFilter] = useState('')
  const [category, setCategory] = useState<FilterCategory>(readStoredFilter)
  const [paused, setPaused] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(paused)

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  useEffect(() => {
    api().getLogs(initialLimit).then(setEntries).catch(() => {})

    const unsub = api().subscribeLogs((entry) => {
      if (pausedRef.current) return
      setEntries((prev) => [...prev.slice(-4999), entry])
    })
    return unsub
  }, [initialLimit])

  useEffect(() => {
    if (paused || !panelRef.current) return
    panelRef.current.scrollTop = panelRef.current.scrollHeight
  }, [entries, paused])

  const filtered = entries.filter((e) => {
    if (!matchesCategory(e, category)) return false
    if (textFilter && !e.text.toLowerCase().includes(textFilter.toLowerCase())) return false
    return true
  })

  const categories: { id: FilterCategory; label: string }[] = [
    { id: 'filtered', label: t('logPanel.filtered') },
    { id: 'all', label: t('logPanel.all') },
    { id: 'error', label: t('logPanel.errors') },
    { id: 'load', label: t('logPanel.load') },
    { id: 'request', label: t('logPanel.requests') }
  ]

  const selectCategory = (id: FilterCategory): void => {
    setCategory(id)
    writeStoredFilter(id)
  }

  const wrapClass = ['log-panel-wrap', compact ? 'compact' : '', fill ? 'fill' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={wrapClass}>
      {title && (
        <div className="log-panel-title-row">
          <h2 className="log-panel-title">{title}</h2>
        </div>
      )}

      <div className={`log-toolbar${compact ? ' log-toolbar-compact' : ''}`}>
        <input
          type="text"
          placeholder={t('logPanel.filterPlaceholder')}
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
        />
        {categories.map((c) => (
          <button
            key={c.id}
            className={`filter-chip${category === c.id ? ' active' : ''}`}
            onClick={() => selectCategory(c.id)}
          >
            {c.label}
          </button>
        ))}
        <button className={`filter-chip${paused ? ' active' : ''}`} onClick={() => setPaused((p) => !p)}>
          {paused ? t('logPanel.paused') : t('logPanel.autoscroll')}
        </button>
        {showClear && (
          <button className="btn" onClick={() => api().clearLogs().then(() => setEntries([]))}>
            {t('logPanel.clear')}
          </button>
        )}
      </div>

      <div
        className="log-panel"
        ref={panelRef}
        style={!fill && maxHeight != null ? { height: maxHeight } : undefined}
      >
        {filtered.length === 0 ? (
          <div className="empty-state">
            {entries.length > 0 ? t('logPanel.emptyFiltered') : t('logPanel.empty')}
          </div>
        ) : (
          filtered.map((e) => (
            <div
              key={e.id}
              className={`log-line${e.level === 'error' ? ' error' : e.level === 'warn' ? ' warn' : e.level === 'debug' ? ' debug' : ''}`}
            >
              <span style={{ color: 'var(--text-muted)' }}>[{formatTime(e.timestamp)}]</span>{' '}
              <span style={{ color: 'var(--text-muted)' }}>[{e.stream}]</span>
              {e.level === 'debug' && <span className="log-level-badge debug">DEBUG</span>}{' '}
              {e.text}
              {e.parsed?.generationTokensPerSec != null && (
                <span style={{ color: 'var(--accent)' }}>
                  {' '}
                  · {e.parsed.generationTokensPerSec.toFixed(1)} tok/s
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
