import { useI18n } from '../../i18n/I18nProvider'
import { api, type ServeState } from '../../types/api'

export default function OllamaServeErrorActions({
  serve,
  onServeChange
}: {
  serve: ServeState | null
  onServeChange?: (state: ServeState) => void
}): JSX.Element | null {
  const { t } = useI18n()
  if (!serve?.portConflict || serve.backend !== 'ollama') return null

  return (
    <div className="btn-row" style={{ marginTop: 8 }}>
      <button
        className="btn btn-primary"
        onClick={() => {
          void api()
            .startServer(true)
            .then((state) => onServeChange?.(state))
        }}
      >
        {t('layout.killConflict')}
      </button>
    </div>
  )
}
