import { useEffect, useState } from 'react'
import LogPanel from '../components/LogPanel'
import { useI18n } from '../i18n/I18nProvider'
import { api, type ServeState } from '../types/api'

export default function Logs(): JSX.Element {
  const { t } = useI18n()
  const [serve, setServe] = useState<ServeState | null>(null)

  useEffect(() => {
    const refresh = (): void => {
      api().getServeStatus().then(setServe).catch(() => {})
    }
    refresh()
    const id = window.setInterval(refresh, 8000)
    return () => window.clearInterval(id)
  }, [])

  return (
    <div className="logs-page">
      <div className="logs-page-header">
        <h1 className="page-title">{t('logs.title')}</h1>
        <p className="logs-page-description">{t('logs.description')}</p>
      </div>
      {serve?.adoptedExisting && (
        <div className="alert alert-info" style={{ marginBottom: 12 }}>
          {t('server.tabbyAdopted', { pid: serve.pid ?? '—' })}
        </div>
      )}
      {serve?.processStatus === 'external' && (
        <div className="alert alert-info" style={{ marginBottom: 12 }}>
          {t('server.tabbyExternal')}
        </div>
      )}
      <div className="logs-panel-section">
        <LogPanel fill />
      </div>
    </div>
  )
}
