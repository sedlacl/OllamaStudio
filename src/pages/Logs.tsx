import LogPanel from '../components/LogPanel'
import { useI18n } from '../i18n/I18nProvider'

export default function Logs(): JSX.Element {
  const { t } = useI18n()
  return (
    <div className="logs-page">
      <div className="logs-page-header">
        <h1 className="page-title">{t('logs.title')}</h1>
        <p className="logs-page-description">{t('logs.description')}</p>
      </div>
      <div className="logs-panel-section">
        <LogPanel fill />
      </div>
    </div>
  )
}
