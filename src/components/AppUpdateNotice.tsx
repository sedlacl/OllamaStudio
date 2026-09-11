import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { api, type AppUpdateState } from '../types/api'

export default function AppUpdateNotice(): JSX.Element | null {
  const { t } = useI18n()
  const [update, setUpdate] = useState<AppUpdateState | null>(null)
  const [actionStarted, setActionStarted] = useState(false)

  useEffect(() => {
    let disposed = false
    const unsubscribe = api().onAppUpdateChanged((state) => {
      if (!disposed) setUpdate(state)
    })
    void api()
      .checkAppUpdate()
      .then((state) => {
        if (!disposed) setUpdate(state)
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const download = async (): Promise<void> => {
    setActionStarted(true)
    setUpdate(await api().downloadAppUpdate())
  }

  const restartAndInstall = async (): Promise<void> => {
    setActionStarted(true)
    setUpdate(await api().restartAndInstallAppUpdate())
  }

  if (
    !update ||
    update.status === 'idle' ||
    update.status === 'checking' ||
    update.status === 'up-to-date' ||
    update.status === 'unsupported' ||
    (update.status === 'error' && !actionStarted)
  ) {
    return null
  }

  const version = update.latestVersion ?? '?'

  return (
    <div className={`alert app-update-notice${update.status === 'error' ? ' alert-error' : ''}`}>
      <div>
        {update.status === 'available' &&
          t('layout.appUpdateAvailable', {
            current: update.currentVersion,
            latest: version
          })}
        {update.status === 'downloading' &&
          t('layout.appUpdateDownloading', {
            version,
            percent: Math.round(update.progressPercent ?? 0)
          })}
        {update.status === 'ready' && t('layout.appUpdateReady', { version })}
        {update.status === 'installing' && t('layout.appUpdateInstalling')}
        {update.status === 'error' &&
          t('layout.appUpdateFailed', { error: update.error ?? t('common.dash') })}
      </div>
      <div className="app-update-actions">
        {update.releaseUrl && (
          <button
            className="btn"
            onClick={() => void api().openExternal(update.releaseUrl!)}
          >
            {t('layout.appUpdateRelease')}
          </button>
        )}
        {update.status === 'available' && (
          <button className="btn btn-primary" onClick={() => void download()}>
            {t('layout.appUpdateDownload')}
          </button>
        )}
        {update.status === 'ready' && (
          <button className="btn btn-primary" onClick={() => void restartAndInstall()}>
            {t('layout.appUpdateRestart')}
          </button>
        )}
      </div>
    </div>
  )
}
