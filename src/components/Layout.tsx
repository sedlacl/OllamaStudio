import { NavLink, Outlet } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { api, type ServeState } from '../types/api'

function statusClass(status: string): string {
  if (status === 'running') return 'status-running'
  if (status === 'starting' || status === 'stopping') return 'status-starting'
  if (status === 'error') return 'status-error'
  return ''
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    running: 'Běží',
    starting: 'Spouští se',
    stopping: 'Zastavuje se',
    stopped: 'Zastaveno',
    error: 'Chyba'
  }
  return map[status] ?? status
}

export default function Layout(): JSX.Element {
  const [serve, setServe] = useState<ServeState | null>(null)

  useEffect(() => {
    const refresh = (): void => {
      api().getServeStatus().then(setServe).catch(() => {})
    }
    refresh()
    const id = setInterval(refresh, 2000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span className="app-title">OllamaStudio</span>
          {serve && (
            <span className={`status-badge ${statusClass(serve.status)}`}>
              <span className="status-dot" />
              {statusLabel(serve.status)}
            </span>
          )}
        </div>
        <nav className="app-nav">
          <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Přehled
          </NavLink>
          <NavLink to="/models" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Modely
          </NavLink>
          <NavLink to="/resources" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            GPU a paměť
          </NavLink>
          <NavLink to="/server" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Server
          </NavLink>
          <NavLink to="/logs" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Logy
          </NavLink>
        </nav>
      </header>
      <main className="app-main">
        {serve?.error && (
          <div className="alert alert-error">
            {serve.error}
            {serve.portConflict && (
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button
                  className="btn btn-primary"
                  onClick={() => api().startServer(true).then(setServe)}
                >
                  Ukončit konfliktní procesy a spustit
                </button>
              </div>
            )}
          </div>
        )}
        <Outlet />
      </main>
    </div>
  )
}
