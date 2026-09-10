import { useI18n } from '../../i18n/I18nProvider'
import type { TabbyLogsPageNoticeProps } from '../types'

export default function TabbyLogsPageNotice({ serve }: TabbyLogsPageNoticeProps): JSX.Element | null {
  const { t } = useI18n()
  if (!serve || serve.backend !== 'tabby') return null

  return (
    <>
      {serve.adoptedExisting && (
        <div className="alert alert-info" style={{ marginBottom: 12 }}>
          {t('server.tabbyAdopted', { pid: serve.pid ?? '—' })}
        </div>
      )}
      {serve.processStatus === 'external' && (
        <div className="alert alert-info" style={{ marginBottom: 12 }}>
          {t('server.tabbyExternal')}
        </div>
      )}
    </>
  )
}
