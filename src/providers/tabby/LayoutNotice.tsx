import { useI18n } from '../../i18n/I18nProvider'
import type { TabbyLayoutNoticeProps } from '../types'

export default function TabbyLayoutNotice({
  serve,
  activeBackend,
  nowMs
}: TabbyLayoutNoticeProps): JSX.Element | null {
  const { t } = useI18n()
  const tabbyStarting =
    (serve?.backend ?? activeBackend) === 'tabby' && serve?.status === 'starting'
  if (!tabbyStarting) return null

  return (
    <div className="alert alert-info">
      {t('layout.tabbyStartingHint')}
      {serve?.spawnTime != null && (
        <div style={{ marginTop: 4 }}>
          {t('layout.tabbyStartingElapsed', {
            seconds: Math.max(0, Math.round((nowMs - serve.spawnTime) / 1000))
          })}
        </div>
      )}
    </div>
  )
}
