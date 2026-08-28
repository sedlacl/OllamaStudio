import { Link } from 'react-router-dom'
import { useI18n } from '../i18n/I18nProvider'

export default function ErrorBanner({
  message,
  onDismiss
}: {
  message: string
  onDismiss: () => void
}): JSX.Element {
  const { t } = useI18n()
  return (
    <div className="alert alert-error" role="alert">
      <div className="alert-error-text">{message}</div>
      <div className="btn-row alert-error-actions">
        <Link to="/logs" className="btn">
          {t('common.openLogs')}
        </Link>
        <button type="button" className="btn" onClick={onDismiss}>
          {t('common.dismissError')}
        </button>
      </div>
    </div>
  )
}
