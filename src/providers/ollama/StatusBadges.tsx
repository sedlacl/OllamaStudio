import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n/I18nProvider'
import {
  api,
  type OllamaUpdateInfo,
  type OllamaUpdateInstallerStatus,
  type ServeState
} from '../../types/api'

export default function OllamaStatusBadges({ serve: _serve }: {
  serve: ServeState | null
}): JSX.Element {
  const { t } = useI18n()
  const [update, setUpdate] = useState<OllamaUpdateInfo | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [installer, setInstaller] = useState<OllamaUpdateInstallerStatus | null>(null)
  const [installerError, setInstallerError] = useState(false)
  const [launchingInstaller, setLaunchingInstaller] = useState(false)
  const [terminalOpened, setTerminalOpened] = useState(false)

  useEffect(() => {
    void api().checkOllamaUpdate().then(setUpdate).catch(() => {})
  }, [])

  useEffect(() => {
    if (!update?.updateAvailable || update.error) {
      setInstaller(null)
      setInstallerError(false)
      return
    }
    let disposed = false
    setInstaller(null)
    setInstallerError(false)
    void api().invokeProviderAction({
      providerId: 'ollama',
      action: 'runtime.update-installer-status',
      payload: {}
    }).then((status) => {
      if (!disposed) setInstaller(status)
    }).catch(() => {
      if (!disposed) setInstallerError(true)
    })
    return () => {
      disposed = true
    }
  }, [update?.checkedAt, update?.error, update?.updateAvailable])

  const checkUpdate = async (): Promise<void> => {
    setCheckingUpdate(true)
    try {
      setUpdate(await api().checkOllamaUpdate(true))
    } finally {
      setCheckingUpdate(false)
    }
  }

  const openUpdateTerminal = async (): Promise<void> => {
    setLaunchingInstaller(true)
    setTerminalOpened(false)
    setInstallerError(false)
    try {
      const result = await api().invokeProviderAction({
        providerId: 'ollama',
        action: 'runtime.open-update-terminal',
        payload: {}
      })
      if (!result.ok) throw new Error(result.reason)
      setTerminalOpened(true)
    } catch {
      setInstallerError(true)
    } finally {
      setLaunchingInstaller(false)
    }
  }

  const installerUnavailableText = (): string | null => {
    if (installerError) return t('server.updateInstallerFailed')
    if (!installer || installer.available) return null
    if (installer.reason === 'unsupported-platform') {
      return t('server.updateInstallerUnsupported')
    }
    if (installer.reason === 'terminal-not-found') {
      return t('server.updateTerminalMissing')
    }
    if (installer.manager === 'apt') {
      return installer.reason === 'manager-not-found'
        ? t('server.aptMissing')
        : t('server.aptPackageMissing')
    }
    return t('server.wingetMissing')
  }

  const unavailableText = installerUnavailableText()

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <div>
          <div className="metric-label">{t('server.versionLabel')}</div>
          <div className="mono">
            {update?.current ?? t('server.versionUnknown')}
            {update?.latest && (
              <span className="metric-label" style={{ margin: 0 }}>
                {' '}
                · {t('server.latestVersion', { version: update.latest })}
              </span>
            )}
          </div>
        </div>
        <button className="btn" onClick={() => void checkUpdate()} disabled={checkingUpdate}>
          {checkingUpdate ? t('server.checking') : t('server.checkUpdate')}
        </button>
      </div>

      {update?.error && (
        <div className="alert" style={{ marginTop: 12, marginBottom: 0 }}>
          {t('server.updateCheckFailed', { error: update.error })}
        </div>
      )}

      {update && !update.error && update.updateAvailable && (
        <div className="alert" style={{ marginTop: 12, marginBottom: 0 }}>
          {t('server.updateAvailable', {
            latest: update.latest ?? '',
            current: update.current ?? '?'
          })}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 10,
              marginTop: 8
            }}
          >
            <a
              href={update.releaseUrl}
              onClick={(e) => {
                e.preventDefault()
                void api().openExternal(update.releaseUrl)
              }}
            >
              {t('server.openRelease')}
            </a>
            {installer?.available && (
              <button
                className="btn"
                onClick={() => void openUpdateTerminal()}
                disabled={launchingInstaller}
              >
                {launchingInstaller
                  ? t('server.openingUpdateTerminal')
                  : t('server.updateViaManager', {
                      manager: installer.manager ?? ''
                    })}
              </button>
            )}
          </div>
          {installer?.available && installer.command && (
            <div className="metric-label" style={{ marginTop: 8 }}>
              {t('server.updateCommand')} <span className="mono">{installer.command}</span>
            </div>
          )}
          {installer?.available && installer.manager === 'apt' && (
            <div className="metric-label" style={{ marginTop: 8 }}>
              {t('server.aptThirdPartyNotice')}
            </div>
          )}
          {!installer && !installerError && (
            <div className="metric-label" style={{ marginTop: 8 }}>
              {t('server.detectingUpdateInstaller')}
            </div>
          )}
          {unavailableText && (
            <div className="metric-label" style={{ marginTop: 8 }}>
              {unavailableText}
            </div>
          )}
          {terminalOpened && (
            <div className="metric-label" style={{ marginTop: 8 }}>
              {t('server.updateTerminalOpened')}
            </div>
          )}
        </div>
      )}

      {update && !update.error && !update.updateAvailable && update.latest && (
        <div className="metric-label" style={{ marginTop: 12 }}>
          {t('server.upToDate')}
        </div>
      )}
    </>
  )
}
