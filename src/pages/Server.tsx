import { useCallback, useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { useBackendProviders } from '../providers/BackendProviderContext'
import { providerDisplayName } from '../providers/i18n-helpers'
import { McpServerSection } from '../components/McpServerSection'
import {
  api,
  type BackendConfigMap,
  type BackendId,
  type ServeState
} from '../types/api'

export default function Server(): JSX.Element {
  const { t } = useI18n()
  const {
    descriptors,
    activeProviderId,
    setActiveProviderId,
    settingsByProvider,
    refreshSettings,
    getDefinition,
    renderSlot
  } = useBackendProviders()

  const [serve, setServe] = useState<ServeState | null>(null)
  const [binary, setBinary] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [switchTarget, setSwitchTarget] = useState<BackendId | null>(null)
  const [switching, setSwitching] = useState(false)
  const [draftByProvider, setDraftByProvider] = useState<Partial<Record<BackendId, unknown>>>({})

  const activeDescriptor = descriptors.find((d) => d.id === activeProviderId)
  const activeDefinition = getDefinition(activeProviderId)

  const draftSettings = useMemo(
    () => (draftByProvider[activeProviderId] ?? settingsByProvider[activeProviderId]) as
      | BackendConfigMap[typeof activeProviderId]
      | undefined,
    [activeProviderId, draftByProvider, settingsByProvider]
  )

  useEffect(() => {
    setDraftByProvider((prev) => {
      const next = { ...prev }
      for (const id of Object.keys(settingsByProvider) as BackendId[]) {
        if (settingsByProvider[id] !== undefined && next[id] === undefined) {
          next[id] = settingsByProvider[id]
        }
      }
      return next
    })
  }, [settingsByProvider])

  const refreshBinary = useCallback((): void => {
    const detect = activeDefinition?.detectRuntimeBinary
    if (!detect) {
      setBinary(null)
      return
    }
    detect().then(setBinary).catch(() => setBinary(null))
  }, [activeDefinition])

  useEffect(() => {
    api().getServeStatus().then(setServe).catch(() => {})
    const servePoll = window.setInterval(() => {
      api().getServeStatus().then(setServe).catch(() => {})
    }, 8000)
    refreshBinary()
    return () => window.clearInterval(servePoll)
  }, [refreshBinary])

  const handleSaveAndRestart = async (): Promise<void> => {
    if (!draftSettings) return
    setSaving(true)
    try {
      await api().saveBackendSettings(activeProviderId, draftSettings as Partial<BackendConfigMap[typeof activeProviderId]>)
      const state = await api().restartServer()
      setServe(state)
      setConfirmRestart(false)
      await refreshSettings(activeProviderId)
      setDraftByProvider((prev) => {
        const next = { ...prev }
        delete next[activeProviderId]
        return next
      })
      refreshBinary()
    } finally {
      setSaving(false)
    }
  }

  const handleSwitchBackend = async (backend: BackendId): Promise<void> => {
    setSwitching(true)
    try {
      const state = await api().switchBackend(backend)
      setServe(state)
      setActiveProviderId(backend)
      await refreshSettings()
      refreshBinary()
    } finally {
      setSwitching(false)
      setSwitchTarget(null)
    }
  }

  const settingsDraft = draftByProvider[activeProviderId] ?? settingsByProvider[activeProviderId]
  const configuredBinaryPath =
    activeDefinition?.getConfiguredRuntimeBinary?.(settingsDraft) ?? null
  const binaryDisplay = serve?.binaryPath ?? binary ?? configuredBinaryPath

  const runtimeBinaryLabelKey = `providers.${activeProviderId}.runtimeBinaryLabel`

  const settingsEditor =
    draftSettings != null
      ? renderSlot(activeProviderId, 'SettingsEditor', {
          settings: draftSettings,
          saving,
          onSettingsChange: (settings: unknown) => {
            setDraftByProvider((prev) => ({ ...prev, [activeProviderId]: settings }))
          }
        })
      : null

  return (
    <div>
      <h1 className="page-title">{t('server.title')}</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-field">
          <label>{t('server.backendLabel')}</label>
          <div className="btn-row" style={{ gap: 16 }}>
            {descriptors.map((descriptor) => (
              <label key={descriptor.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="radio"
                  name="active-backend"
                  checked={activeProviderId === descriptor.id}
                  disabled={switching}
                  onChange={() => {
                    if (activeProviderId !== descriptor.id) setSwitchTarget(descriptor.id)
                  }}
                />
                {providerDisplayName(t, descriptor)}
              </label>
            ))}
          </div>
          <span className="field-help">{t('server.backendHint')}</span>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="metric-label">{t(runtimeBinaryLabelKey as `providers.${typeof activeProviderId}.runtimeBinaryLabel`)}</div>
        <div className="mono">{binaryDisplay?.trim() || t('server.binaryMissing')}</div>
        {serve?.pid && (
          <div className="metric-label" style={{ marginTop: 8 }}>
            {t('server.pidServe', { pid: serve.pid })}
          </div>
        )}

        {renderSlot(activeProviderId, 'StatusBadges', { serve })}
      </div>

      {activeDescriptor && (
        <div className="alert alert-info">{t(`providers.${activeProviderId}.serverInfo`)}</div>
      )}

      {settingsEditor}

      <McpServerSection />

      <div className="btn-row" style={{ marginTop: 16 }}>
        <button className="btn btn-primary" onClick={() => setConfirmRestart(true)} disabled={saving}>
          {t('server.saveRestart')}
        </button>
        <button className="btn" onClick={() => api().startServer().then(setServe)}>
          {t('server.start')}
        </button>
        <button className="btn" onClick={() => api().stopServer().then(setServe)}>
          {t('server.stop')}
        </button>
        <button className="btn" onClick={() => api().restartServer().then(setServe)}>
          {t('server.restart')}
        </button>
      </div>

      {confirmRestart && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>{t('server.confirmTitle')}</h3>
            <p>{t(`providers.${activeProviderId}.confirmRestart`)}</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmRestart(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" onClick={() => void handleSaveAndRestart()} disabled={saving}>
                {saving ? t('server.saving') : t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {switchTarget && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>{t('server.switchBackendTitle')}</h3>
            <p>
              {t('server.switchBackendBody', {
                backend: providerDisplayName(
                  t,
                  descriptors.find((d) => d.id === switchTarget)
                )
              })}
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setSwitchTarget(null)} disabled={switching}>
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void handleSwitchBackend(switchTarget)}
                disabled={switching}
              >
                {switching ? t('server.switching') : t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
