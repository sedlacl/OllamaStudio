import { useI18n } from '../../i18n/I18nProvider'
import type { TabbyStatusBadgesProps } from '../types'

export default function TabbyStatusBadges({ serve }: TabbyStatusBadgesProps): JSX.Element | null {
  const { t } = useI18n()
  if (!serve || serve.backend !== 'tabby') return null
  const authFingerprint = serve.auth

  return (
    <>
      {serve.adoptedExisting && (
        <div className="alert alert-info" style={{ marginTop: 12, marginBottom: 0 }}>
          {t('providers.tabby.adoptedExisting', { pid: serve.pid ?? '—' })}
        </div>
      )}
      {serve.processStatus === 'external' && (
        <div className="alert alert-info" style={{ marginTop: 12, marginBottom: 0 }}>
          {t('providers.tabby.externalProcess')}
        </div>
      )}
      {authFingerprint && (
        <div style={{ marginTop: 12 }}>
          <div className="metric-label">{t('server.authFingerprint')}</div>
          <ul className="metric-label" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            <li>
              {t('server.authApiKey')}:{' '}
              {authFingerprint.disableAuth
                ? t('server.authDisabled')
                : authFingerprint.hasApiKey
                  ? t('server.authConfigured')
                  : t('server.authMissing')}
            </li>
            <li>
              {t('server.authAdminKey')}:{' '}
              {authFingerprint.disableAuth
                ? t('server.authDisabled')
                : authFingerprint.hasAdminKey
                  ? t('server.authConfigured')
                  : t('server.authMissing')}
            </li>
            <li>
              {t('server.authDisableFlag')}:{' '}
              {authFingerprint.disableAuth ? t('common.on') : t('common.off')}
            </li>
          </ul>
        </div>
      )}
    </>
  )
}
