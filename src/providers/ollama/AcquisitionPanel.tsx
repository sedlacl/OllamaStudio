import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n/I18nProvider'
import { api, type AcquisitionState } from '../../types/api'
import type { AcquisitionPanelProps } from '../types'

export default function OllamaAcquisitionPanel({
  onModelsChanged,
  onError
}: AcquisitionPanelProps): JSX.Element {
  const { t } = useI18n()
  const [pullName, setPullName] = useState('')
  const [pullProgress, setPullProgress] = useState<AcquisitionState | null>(null)
  const [pulling, setPulling] = useState(false)

  useEffect(() => {
    const apply = (state: AcquisitionState): void => {
      if (state.providerId === 'ollama') setPullProgress(state)
    }
    void api()
      .getModelAcquisitions()
      .then((states) => {
        const current = states.find((state) => state.providerId === 'ollama')
        if (current) apply(current)
      })
      .catch(() => {})
    return api().onModelAcquisitionChanged(apply)
  }, [])

  const pullPercent =
    pullProgress?.percent != null ? Math.round(pullProgress.percent) : null

  const handlePull = async (): Promise<void> => {
    const name = pullName.trim()
    if (!name) return
    setPulling(true)
    setPullProgress(null)
    const result = await api().startModelAcquisition({
      providerId: 'ollama',
      source: 'library',
      modelId: name
    })
    setPulling(false)
    if (!result.ok) {
      onError?.(result.error ?? t('models.pullFailed'))
    } else {
      setPullName('')
      onModelsChanged?.()
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="form-field">
        <label>{t('models.pullLabel')}</label>
        <div className="btn-row">
          <input
            type="text"
            placeholder={t('models.pullPlaceholder')}
            value={pullName}
            onChange={(e) => setPullName(e.target.value)}
            disabled={pulling}
            style={{ flex: 1, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6 }}
          />
          <button className="btn btn-primary" onClick={() => void handlePull()} disabled={pulling || !pullName.trim()}>
            {pulling ? t('models.downloading') : t('models.download')}
          </button>
        </div>
      </div>
      {pullProgress && (
        <div style={{ marginTop: 8 }}>
          <span className="mono">{pullProgress.status}</span>
          {pullPercent != null && (
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${pullPercent}%` }} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
