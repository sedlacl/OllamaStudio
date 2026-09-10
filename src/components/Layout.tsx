import { NavLink, Outlet } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { useBackendProviders } from '../providers/BackendProviderContext'
import { providerDisplayNameById } from '../providers/i18n-helpers'
import { api, type ServeState } from '../types/api'
import { isBackendId } from '../../shared/backend-contract'

function statusClass(status: string): string {
  if (status === 'running') return 'status-running'
  if (status === 'starting' || status === 'stopping') return 'status-starting'
  if (status === 'error') return 'status-error'
  return ''
}

export default function Layout(): JSX.Element {
  const { t, locale, setLocale } = useI18n()
  const { descriptors, descriptorsById, renderSlot } = useBackendProviders()
  const [serve, setServe] = useState<ServeState | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const activeBackendId = serve?.backend ?? descriptors[0]?.id ?? 'ollama'

  useEffect(() => {
    api().getAppVersion().then(setVersion).catch(() => {})
  }, [])

  useEffect(() => {
    const refresh = (): void => {
      api()
        .getServeStatus()
        .then(setServe)
        .catch(() => {})
    }
    refresh()
    const id = setInterval(refresh, 8000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const starting = serve?.status === 'starting'
    if (!starting) return
    setNowMs(Date.now())
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [serve?.status])

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

  const backendLabel = isBackendId(activeBackendId)
    ? providerDisplayNameById(t, activeBackendId, descriptorsById)
    : activeBackendId

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
        {descriptors.map((descriptor) =>
          renderSlot(descriptor.id, 'LayoutNotice', {
            serve,
            activeBackend: activeBackendId,
            nowMs
          })
        )}
        {serve?.error && (
          <div className="alert alert-error">
            {serve.error}
            {serve.backend &&
              renderSlot(serve.backend, 'ServeErrorActions', {
                serve,
                onServeChange: setServe
              })}
          </div>
        )}
        <Outlet />
      </main>
    </div>
  )
}
