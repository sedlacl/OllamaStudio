import { NavLink, Outlet } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { api, type BackendId, type ServeState } from '../types/api'

function statusClass(status: string): string {
  if (status === 'running') return 'status-running'
  if (status === 'starting' || status === 'stopping') return 'status-starting'
  if (status === 'error') return 'status-error'
  return ''
}

export default function Layout(): JSX.Element {
  const { t, locale, setLocale } = useI18n()
  const [serve, setServe] = useState<ServeState | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [activeBackend, setActiveBackend] = useState<BackendId>('ollama')

  useEffect(() => {
    api().getAppVersion().then(setVersion).catch(() => {})
    api()
      .getServerConfig()
      .then((cfg) => setActiveBackend(cfg.activeBackend === 'tabby' ? 'tabby' : 'ollama'))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const refresh = (): void => {
      api()
        .getServeStatus()
        .then((state) => {
          setServe(state)
          if (state.backend) setActiveBackend(state.backend)
        })
        .catch(() => {})
    }
    refresh()
    const id = setInterval(refresh, 8000)
    return () => clearInterval(id)
  }, [])

  const statusLabel = (status: string): string => {
    const map: Record<string, string> = {
      running: t('status.running'),
      starting: t('status.starting'),
      stopping: t('status.stopping'),
      stopped: t('status.stopped'),
      error: t('status.error')
    }
    return map[status] ?? status
  }

  const backendLabel =
    (serve?.backend ?? activeBackend) === 'tabby' ? t('backend.tabby') : t('backend.ollama')

  return (
    <div className="app-shell">
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span className="app-title">OllamaStudio</span>
          {version && <span className="app-version">v{version}</span>}
          <span className="status-badge status-backend">{backendLabel}</span>
          {serve && (
            <span className={`status-badge ${statusClass(serve.status)}`}>
              <span className="status-dot" />
              {statusLabel(serve.status)}
            </span>
          )}
          {serve?.adoptedExisting && (
            <span className="status-badge status-backend">{t('status.adopted')}</span>
          )}
          {serve?.processStatus === 'external' && (
            <span className="status-badge status-backend">{t('status.external')}</span>
          )}
        </div>
        <div className="app-header-right">
          <nav className="app-nav">
            <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              {t('nav.overview')}
            </NavLink>
            <NavLink to="/models" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              {t('nav.models')}
            </NavLink>
            <NavLink
              to="/resources"
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              {t('nav.resources')}
            </NavLink>
            <NavLink to="/server" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              {t('nav.server')}
            </NavLink>
            <NavLink to="/logs" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              {t('nav.logs')}
            </NavLink>
          </nav>
          <select
            className="lang-select"
            aria-label={t('lang.switchAria')}
            value={locale}
            onChange={(e) => setLocale(e.target.value as typeof locale)}
          >
            <option value="cs">{t('lang.cs')}</option>
            <option value="en">{t('lang.en')}</option>
          </select>
        </div>
      </header>
      <main className="app-main">
        {serve?.error && (
          <div className="alert alert-error">
            {serve.error}
            {serve.portConflict && serve.backend !== 'tabby' && (
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button
                  className="btn btn-primary"
                  onClick={() => api().startServer(true).then(setServe)}
                >
                  {t('layout.killConflict')}
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
