import { useEffect, useRef, useState } from 'react'
import { api, type LogEntry } from '../types/api'

type FilterCategory = 'all' | 'error' | 'load' | 'unload' | 'request'

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('cs-CZ')
}

export default function Logs(): JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [textFilter, setTextFilter] = useState('')
  const [category, setCategory] = useState<FilterCategory>('all')
  const [paused, setPaused] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(paused)

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  useEffect(() => {
    api().getLogs(1000).then(setEntries).catch(() => {})

    const unsub = api().subscribeLogs((entry) => {
      if (pausedRef.current) return
      setEntries((prev) => [...prev.slice(-4999), entry])
    })
    return unsub
  }, [])

  useEffect(() => {
    if (paused || !panelRef.current) return
    panelRef.current.scrollTop = panelRef.current.scrollHeight
  }, [entries, paused])

  const filtered = entries.filter((e) => {
    if (category !== 'all' && e.category !== category) return false
    if (textFilter && !e.text.toLowerCase().includes(textFilter.toLowerCase())) return false
    return true
  })

  const categories: { id: FilterCategory; label: string }[] = [
    { id: 'all', label: 'Vše' },
    { id: 'error', label: 'Chyby' },
    { id: 'load', label: 'Load' },
    { id: 'unload', label: 'Unload' },
    { id: 'request', label: 'Požadavky' }
  ]

  return (
    <div>
      <h1 className="page-title">Logy serve</h1>
      <p style={{ color: 'var(--text-muted)', margin: '0 0 12px' }}>
        Živý stream stdout/stderr procesu <code>ollama serve</code>. Historie se ukládá také do{' '}
        <span className="mono">userData/logs/ollama-serve.log</span>.
      </p>

      <div className="log-toolbar">
        <input
          type="text"
          placeholder="Filtrovat text…"
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
        />
        {categories.map((c) => (
          <button
            key={c.id}
            className={`filter-chip${category === c.id ? ' active' : ''}`}
            onClick={() => setCategory(c.id)}
          >
            {c.label}
          </button>
        ))}
        <button className={`filter-chip${paused ? ' active' : ''}`} onClick={() => setPaused((p) => !p)}>
          {paused ? 'Pozastaveno' : 'Autoscroll'}
        </button>
        <button className="btn" onClick={() => api().clearLogs().then(() => setEntries([]))}>
          Vymazat
        </button>
      </div>

      <div className="log-panel" ref={panelRef}>
        {filtered.length === 0 ? (
          <div className="empty-state">Žádné logy{entries.length > 0 ? ' (filtr)' : ''}</div>
        ) : (
          filtered.map((e) => (
            <div
              key={e.id}
              className={`log-line${e.level === 'error' ? ' error' : e.level === 'warn' ? ' warn' : ''}`}
            >
              <span style={{ color: 'var(--text-muted)' }}>[{formatTime(e.timestamp)}]</span>{' '}
              <span style={{ color: 'var(--text-muted)' }}>[{e.stream}]</span> {e.text}
              {e.parsed?.generationTokensPerSec != null && (
                <span style={{ color: 'var(--accent)' }}> · {e.parsed.generationTokensPerSec.toFixed(1)} tok/s</span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
