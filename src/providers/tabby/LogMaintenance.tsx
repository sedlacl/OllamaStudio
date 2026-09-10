import { useState } from 'react'
import { useI18n } from '../../i18n/I18nProvider'
import { api, type ServeState } from '../../types/api'
import type { TabbyLogMaintenanceProps } from '../types'

function tabbyStoppedForScrub(state: ServeState | null): boolean {
  if (!state) return false
  if (state.backend !== 'tabby') return false
  const ps = state.processStatus ?? state.status
  return ps !== 'running' && ps !== 'starting' && ps !== 'external'
}

export default function TabbyLogMaintenance({
  serveState,
  onMessage
}: TabbyLogMaintenanceProps): JSX.Element | null {
  const { t } = useI18n()
  const [pendingZipPaths, setPendingZipPaths] = useState<string[]>([])

  if (serveState?.backend !== 'tabby') return null

  const tabbyInstallDir =
    serveState.binaryPath != null
      ? serveState.binaryPath.replace(/[/\\][^/\\]+$/, '')
      : 'D:\\AI\\Tabby'

  const scrubTabbyAllowed = tabbyStoppedForScrub(serveState)

  const scrubTabbyLogs = (): void => {
    if (!scrubTabbyAllowed) {
      window.alert(t('logPanel.scrubTabbyBlocked'))
      return
    }
    if (
      !window.confirm(
        `${t('logPanel.scrubTabbyConfirmTitle')}\n\n${t('logPanel.scrubTabbyConfirm', { installDir: tabbyInstallDir })}`
      )
    ) {
      return
    }
    void api()
      .scrubTabbyRuntimeLogs()
      .then((result) => {
        const changed = result.scrubbed.reduce((sum, row) => sum + row.linesChanged, 0)
        setPendingZipPaths(result.zipFiles)
        let message = t('logPanel.scrubTabbyDone', { changed: String(changed) })
        if (result.zipFiles.length > 0) {
          message = `${message}\n${t('logPanel.scrubTabbyZipList')}\n${result.zipFiles.map((p) => p.split(/[/\\]/).pop()).join('\n')}`
        }
        onMessage?.(message)
      })
      .catch((err: unknown) => {
        window.alert(err instanceof Error ? err.message : String(err))
      })
  }

  const deleteTabbyZipLogs = (): void => {
    if (!scrubTabbyAllowed) {
      window.alert(t('logPanel.scrubTabbyBlocked'))
      return
    }
    if (pendingZipPaths.length === 0) {
      void api()
        .scrubTabbyRuntimeLogs()
        .then((result) => setPendingZipPaths(result.zipFiles))
        .catch(() => {})
      window.alert(t('logPanel.scrubTabbyZipList'))
      return
    }
    if (
      !window.confirm(
        `${t('logPanel.deleteTabbyZipConfirmTitle')}\n\n${t('logPanel.deleteTabbyZipConfirm', { count: pendingZipPaths.length })}`
      )
    ) {
      return
    }
    void api()
      .deleteTabbyRuntimeZipLogs(pendingZipPaths)
      .then((result) => {
        setPendingZipPaths((prev) => prev.filter((p) => !result.deleted.includes(p)))
        onMessage?.(t('logPanel.deleteTabbyZipDone', { count: result.deleted.length }))
        if (result.errors.length > 0) {
          onMessage?.(result.errors.join('\n'))
        }
      })
      .catch((err: unknown) => {
        window.alert(err instanceof Error ? err.message : String(err))
      })
  }

  return (
    <>
      <button
        className="btn"
        onClick={scrubTabbyLogs}
        disabled={!scrubTabbyAllowed}
        title={t('logPanel.scrubTabby')}
      >
        {t('logPanel.scrubTabby')}
      </button>
      <button
        className="btn"
        onClick={deleteTabbyZipLogs}
        disabled={!scrubTabbyAllowed}
        title={t('logPanel.deleteTabbyZip')}
      >
        {t('logPanel.deleteTabbyZip')}
      </button>
    </>
  )
}
