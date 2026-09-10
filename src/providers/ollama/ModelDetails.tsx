import { useI18n } from '../../i18n/I18nProvider'
import type { BackendConfigMap } from '../../../shared/backend-contract'
import type { AppConfig, ModelShow } from '../../types/api'

function MonoBlock({ text, emptyLabel }: { text?: string | null; emptyLabel: string }): JSX.Element {
  if (!text?.trim()) {
    return <p className="detail-unavailable">{emptyLabel}</p>
  }
  return <pre className="detail-mono-block mono">{text}</pre>
}

function ObjectGrid({
  data,
  emptyLabel,
  unavailableLabel
}: {
  data?: Record<string, unknown> | null
  emptyLabel: string
  unavailableLabel: string
}): JSX.Element {
  if (!data || Object.keys(data).length === 0) {
    return <p className="detail-unavailable">{emptyLabel}</p>
  }
  const entries = Object.entries(data).sort(([a], [b]) => a.localeCompare(b))
  return (
    <div className="detail-kv-grid">
      {entries.map(([key, value]) => {
        const formatted =
          value !== null && typeof value === 'object'
            ? JSON.stringify(value, null, 2)
            : value === undefined || value === null || value === ''
              ? unavailableLabel
              : String(value)
        return (
          <div className="detail-kv-row" key={key}>
            <div className="detail-kv-label">{key}</div>
            <div className={`detail-kv-value mono${formatted === unavailableLabel ? ' detail-unavailable' : ''}`}>
              {formatted}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function OllamaModelDetails({
  modelId,
  show: showRaw,
  config: configRaw
}: {
  modelId: string
  show?: unknown
  config?: unknown
}): JSX.Element {
  const show = (showRaw ?? null) as ModelShow | null
  const config = (configRaw ?? null) as AppConfig | BackendConfigMap['ollama'] | null
  void modelId
  const { t } = useI18n()
  const unavailable = t('details.unavailable')
  const env =
    config && typeof config === 'object' && 'env' in config
      ? (config as BackendConfigMap['ollama']).env
      : (config as AppConfig | null)?.providers?.ollama?.env ??
        (config as AppConfig | null)?.ollamaEnv

  return (
    <>
      <section className="detail-section">
        <div className="detail-section-heading">
          <h4>{t('details.modelTitle')}</h4>
          <span className="detail-source-note">{t('details.modelNote')}</span>
        </div>
        {!show ? (
          <p className="detail-unavailable">{unavailable}</p>
        ) : (
          <>
            <h5 className="detail-subsection">parameters</h5>
            <p className="field-help">{t('details.parametersNote')}</p>
            <MonoBlock text={show.parameters} emptyLabel={unavailable} />
            <h5 className="detail-subsection">details</h5>
            <ObjectGrid
              data={show.details as Record<string, unknown> | undefined}
              emptyLabel={unavailable}
              unavailableLabel={unavailable}
            />
            <h5 className="detail-subsection">model_info</h5>
            <ObjectGrid data={show.model_info} emptyLabel={unavailable} unavailableLabel={unavailable} />
            <h5 className="detail-subsection">template</h5>
            <MonoBlock text={show.template} emptyLabel={unavailable} />
            <h5 className="detail-subsection">modelfile</h5>
            <MonoBlock text={show.modelfile} emptyLabel={unavailable} />
          </>
        )}
      </section>

      <section className="detail-section">
        <div className="detail-section-heading">
          <h4>{t('details.serveTitle')}</h4>
          <span className="detail-source-note">{t('details.serveNote')}</span>
        </div>
        {!env ? (
          <p className="detail-unavailable">{t('details.configUnavailable')}</p>
        ) : (
          <div className="detail-kv-grid">
            {(Object.keys(env) as Array<keyof typeof env>).map((key) => (
              <div className="detail-kv-row" key={key}>
                <div className="detail-kv-label">{key}</div>
                <div
                  className={`detail-kv-value mono${env[key] === '' ? ' detail-unavailable' : ''}`}
                >
                  {env[key] !== '' ? env[key] : t('details.emptyDefault')}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
