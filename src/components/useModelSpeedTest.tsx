import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { api, type ModelSpeedTestResult } from '../types/api'

export interface ModelSpeedTest {
  /** Jméno modelu, na kterém test právě běží. */
  busyModel: string | null
  /** Poslední výsledky podle modelu (klíč je název modelu malými písmeny). */
  results: Record<string, ModelSpeedTestResult>
  resultFor: (name: string) => ModelSpeedTestResult | null
  run: (name: string) => void
  /** Modal s výsledkem / chybou; vykreslete ho v stránce. */
  dialog: ReactNode
}

/**
 * Krátký "Hello world" prompt do modelu + změření TTFT a rychlosti generování.
 * Sdílené mezi Přehledem, Využitím zdrojů a Modely, aby akce byla všude stejná.
 */
export function useModelSpeedTest(onFinished?: () => void): ModelSpeedTest {
  const { t } = useI18n()
  const [busyModel, setBusyModel] = useState<string | null>(null)
  const [result, setResult] = useState<ModelSpeedTestResult | null>(null)
  const [error, setError] = useState<{ name: string; message: string } | null>(null)
  const [results, setResults] = useState<Record<string, ModelSpeedTestResult>>({})

  const refreshResults = useCallback(async (): Promise<void> => {
    try {
      setResults(await api().getSpeedTests())
    } catch {
      /* serve neběží — sloupce zůstanou prázdné */
    }
  }, [])

  useEffect(() => {
    void refreshResults()
    // Testy spouštěné mimo tuhle stránku (automaticky po načtení modelu) hlásí main proces.
    return api().onSpeedTestsChanged(() => {
      void refreshResults()
    })
  }, [refreshResults])

  const resultFor = (name: string): ModelSpeedTestResult | null =>
    results[name.trim().toLowerCase()] ?? null

  const run = (name: string): void => {
    if (busyModel) return
    setBusyModel(name)
    setResult(null)
    setError(null)
    void api()
      .modelTestSpeed(name)
      .then((value) => setResult(value))
      .catch((e: unknown) => {
        setError({
          name,
          message: e instanceof Error ? e.message : t('speedTest.failed')
        })
      })
      .finally(() => {
        setBusyModel(null)
        void refreshResults()
        onFinished?.()
      })
  }

  const close = (): void => {
    setResult(null)
    setError(null)
  }

  const dialog =
    result || error ? (
      <div className="modal-backdrop" onClick={close}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>{t('speedTest.resultTitle', { name: result?.model ?? error?.name ?? '' })}</h3>
          {error ? (
            <div className="alert alert-error">{error.message}</div>
          ) : (
            result && (
              <>
                <div className="card-grid" style={{ marginBottom: 0 }}>
                  <div className="card">
                    <div className="metric-label">{t('speedTest.ttft')}</div>
                    <div className="metric-value">{result.ttftMs.toFixed(0)} ms</div>
                    <div className="metric-label">{t('speedTest.ttftHint')}</div>
                  </div>
                  <div className="card">
                    <div className="metric-label">{t('speedTest.throughput')}</div>
                    <div className="metric-value">{result.tokensPerSecond.toFixed(1)} tok/s</div>
                    <div className="metric-label">
                      {t('speedTest.throughputHint', { tokens: result.generatedTokens })}
                    </div>
                  </div>
                  <div className="card">
                    <div className="metric-label">{t('speedTest.promptSpeed')}</div>
                    <div className="metric-value">
                      {result.promptTokensPerSecond.toFixed(1)} tok/s
                    </div>
                    <div className="metric-label">
                      {t('speedTest.promptSpeedHint', {
                        tokens: result.promptTokens,
                        ms: result.promptEvalMs.toFixed(0)
                      })}
                    </div>
                  </div>
                </div>
                <p className="field-help">{t('speedTest.method')}</p>
                <p className="field-help">
                  {result.wasLoaded
                    ? t('speedTest.wasLoaded')
                    : t('speedTest.hadToLoad', { load: result.loadMs.toFixed(0) })}
                </p>
                <div className="form-field">
                  <label>
                    {result.response || !result.thinking
                      ? t('speedTest.response')
                      : t('speedTest.thinking')}
                  </label>
                  <pre
                    className="mono"
                    style={{ maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap' }}
                  >
                    {result.response || result.thinking || '—'}
                  </pre>
                </div>
              </>
            )
          )}
          <div className="modal-actions">
            <button className="btn" onClick={close}>
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    ) : null

  return { busyModel, results, resultFor, run, dialog }
}
