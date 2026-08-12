import { useEffect, useState, type ReactNode } from 'react'
import {
  api,
  type AppConfig,
  type ModelLoadOptions,
  type ModelShow,
  type RecordedLoadOptions,
  type RunningModel
} from '../types/api'

const UNAVAILABLE = 'Nedostupné z Ollama API'

export interface LoadedModelDetailsDialogProps {
  modelName: string
  onClose: () => void
}

function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return UNAVAILABLE
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${bytes} B`
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return UNAVAILABLE
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : UNAVAILABLE
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.length ? value.map(String).join(', ') : UNAVAILABLE
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatLoadOptionValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function formatRecordedAt(ts: number): string {
  try {
    return new Date(ts).toLocaleString('cs-CZ')
  } catch {
    return String(ts)
  }
}

function DetailRow({
  label,
  value,
  mono = true,
  unavailable = false
}: {
  label: string
  value: string
  mono?: boolean
  unavailable?: boolean
}): JSX.Element {
  return (
    <div className="detail-kv-row">
      <div className="detail-kv-label">{label}</div>
      <div className={`detail-kv-value${mono ? ' mono' : ''}${unavailable ? ' detail-unavailable' : ''}`}>
        {value}
      </div>
    </div>
  )
}

function Section({
  title,
  sourceNote,
  children
}: {
  title: string
  sourceNote: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="detail-section">
      <div className="detail-section-heading">
        <h4>{title}</h4>
        <span className="detail-source-note">{sourceNote}</span>
      </div>
      {children}
    </section>
  )
}

function KvGrid({ children }: { children: ReactNode }): JSX.Element {
  return <div className="detail-kv-grid">{children}</div>
}

function MonoBlock({ text, emptyLabel = UNAVAILABLE }: { text?: string | null; emptyLabel?: string }): JSX.Element {
  if (!text?.trim()) {
    return <p className="detail-unavailable">{emptyLabel}</p>
  }
  return <pre className="detail-mono-block mono">{text}</pre>
}

function ObjectGrid({
  data,
  emptyLabel = UNAVAILABLE
}: {
  data?: Record<string, unknown> | null
  emptyLabel?: string
}): JSX.Element {
  if (!data || Object.keys(data).length === 0) {
    return <p className="detail-unavailable">{emptyLabel}</p>
  }
  const entries = Object.entries(data).sort(([a], [b]) => a.localeCompare(b))
  return (
    <KvGrid>
      {entries.map(([key, value]) => {
        const formatted =
          value !== null && typeof value === 'object'
            ? JSON.stringify(value, null, 2)
            : formatValue(value)
        const unavailable = formatted === UNAVAILABLE
        return (
          <DetailRow
            key={key}
            label={key}
            value={formatted}
            unavailable={unavailable}
          />
        )
      })}
    </KvGrid>
  )
}

function findRunningModel(models: RunningModel[], name: string): RunningModel | null {
  const target = name.trim().toLowerCase()
  return (
    models.find((m) => m.name.toLowerCase() === target || m.model.toLowerCase() === target) ?? null
  )
}

const LOAD_OPTION_LABELS: Array<{ key: keyof ModelLoadOptions; label: string }> = [
  { key: 'keepAlive', label: 'keep_alive' },
  { key: 'numCtx', label: 'num_ctx' },
  { key: 'numBatch', label: 'num_batch' },
  { key: 'numGpu', label: 'num_gpu' },
  { key: 'numThread', label: 'num_thread' },
  { key: 'useMmap', label: 'use_mmap' },
  { key: 'useMlock', label: 'use_mlock' },
  { key: 'ropeFrequencyBase', label: 'rope_frequency_base' },
  { key: 'ropeFrequencyScale', label: 'rope_frequency_scale' }
]

export default function LoadedModelDetailsDialog({
  modelName,
  onClose
}: LoadedModelDetailsDialogProps): JSX.Element {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState<RunningModel | null>(null)
  const [show, setShow] = useState<ModelShow | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [recorded, setRecorded] = useState<RecordedLoadOptions | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle')

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const [ps, showData, serverConfig, loadOpts] = await Promise.all([
          api().getModelsPs(),
          api().modelShow(modelName).catch(() => null),
          api().getServerConfig(),
          api().getModelLoadOptions(modelName)
        ])
        if (cancelled) return
        setRunning(findRunningModel(ps, modelName))
        setShow(showData)
        setConfig(serverConfig)
        setRecorded(loadOpts)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Nepodařilo se načíst detaily modelu')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [modelName])

  const details = running?.details
  const env = config?.ollamaEnv

  const copyToJson = async (): Promise<void> => {
    const payload = {
      modelName,
      exportedAt: new Date().toISOString(),
      runtime: running,
      model: show,
      serveConfig: env ?? null,
      loadOptions: recorded
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      setCopyState('ok')
    } catch {
      setCopyState('err')
    }
    window.setTimeout(() => setCopyState('idle'), 2000)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal load-dialog detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="loaded-model-details-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="load-dialog-header">
          <div>
            <h3 id="loaded-model-details-title">Parametry načteného modelu</h3>
            <p className="load-dialog-subtitle mono">{modelName}</p>
          </div>
          <button className="dialog-close" onClick={onClose} aria-label="Zavřít">
            ×
          </button>
        </div>

        <div className="load-dialog-body detail-dialog-body">
          {loading && <p className="empty-state">Načítání parametrů…</p>}
          {error && <div className="alert alert-error">{error}</div>}

          {!loading && !error && (
            <>
              <Section title="Runtime (/api/ps)" sourceNote="Hodnoty vrácené Ollama API — ne interní runner stav">
                {!running ? (
                  <p className="detail-unavailable">
                    Model není v /api/ps (možná byl mezitím uvolněn).
                  </p>
                ) : (
                  <KvGrid>
                    <DetailRow label="name" value={formatValue(running.name)} />
                    <DetailRow label="model" value={formatValue(running.model)} />
                    <DetailRow label="digest" value={formatValue(running.digest)} />
                    <DetailRow label="size" value={formatBytes(running.size)} unavailable={running.size == null} />
                    <DetailRow
                      label="size_vram"
                      value={formatBytes(running.size_vram)}
                      unavailable={running.size_vram == null}
                    />
                    <DetailRow
                      label="context_length"
                      value={
                        running.context_length != null
                          ? running.context_length.toLocaleString('cs-CZ')
                          : UNAVAILABLE
                      }
                      unavailable={running.context_length == null}
                    />
                    <DetailRow label="expires_at" value={formatValue(running.expires_at)} />
                    <DetailRow label="details.format" value={formatValue(details?.format)} unavailable={!details?.format} />
                    <DetailRow label="details.family" value={formatValue(details?.family)} unavailable={!details?.family} />
                    <DetailRow
                      label="details.parameter_size"
                      value={formatValue(details?.parameter_size)}
                      unavailable={!details?.parameter_size}
                    />
                    <DetailRow
                      label="details.quantization_level"
                      value={formatValue(details?.quantization_level)}
                      unavailable={!details?.quantization_level}
                    />
                    <DetailRow
                      label="details.families"
                      value={formatValue(details?.families)}
                      unavailable={!details?.families?.length}
                    />
                    <DetailRow
                      label="details.parent_model"
                      value={formatValue(details?.parent_model || undefined)}
                      unavailable={!details?.parent_model}
                    />
                  </KvGrid>
                )}
                <p className="detail-epistemic-note">
                  Další interní hodnoty runneru (batch, thread, mmap, …) Ollama v /api/ps nevrací →{' '}
                  <span className="detail-unavailable">{UNAVAILABLE}</span>.
                </p>
              </Section>

              <Section title="Model (/api/show)" sourceNote="Metadata modelu z Ollama API">
                {!show ? (
                  <p className="detail-unavailable">{UNAVAILABLE}</p>
                ) : (
                  <>
                    <h5 className="detail-subsection">parameters</h5>
                    <MonoBlock text={show.parameters} />

                    <h5 className="detail-subsection">details</h5>
                    <ObjectGrid data={show.details as Record<string, unknown> | undefined} />

                    <h5 className="detail-subsection">model_info</h5>
                    <ObjectGrid data={show.model_info} />

                    <h5 className="detail-subsection">capabilities</h5>
                    <KvGrid>
                      <DetailRow
                        label="capabilities"
                        value={formatValue(show.capabilities)}
                        unavailable={!show.capabilities?.length}
                      />
                    </KvGrid>

                    <h5 className="detail-subsection">template</h5>
                    <MonoBlock text={show.template} />

                    <h5 className="detail-subsection">modelfile</h5>
                    <MonoBlock text={show.modelfile} />
                  </>
                )}
              </Section>

              <Section
                title="Konfigurace serve (OLLAMA_* / LLAMA_*)"
                sourceNote="Aktuální konfigurace OllamaStudio — není důkaz runtime hodnot runneru"
              >
                {!env ? (
                  <p className="detail-unavailable">Konfigurace nedostupná</p>
                ) : (
                  <KvGrid>
                    {(Object.keys(env) as Array<keyof typeof env>).map((key) => (
                      <DetailRow
                        key={key}
                        label={key}
                        value={env[key] !== '' ? env[key] : '(prázdné / výchozí Ollama)'}
                        unavailable={env[key] === ''}
                      />
                    ))}
                  </KvGrid>
                )}
              </Section>

              <Section
                title="Volby při načtení (OllamaStudio)"
                sourceNote="Přesné options odeslané při modelLoad v této relaci aplikace"
              >
                {!recorded ? (
                  <p className="detail-unavailable">
                    Nedostupné — model nebyl načten přes OllamaStudio v této relaci, nebo byl serve
                    restartován / aplikace restartována.
                  </p>
                ) : (
                  <>
                    <p className="detail-meta mono">
                      zaznamenáno: {formatRecordedAt(recorded.recordedAt)} · {recorded.modelName}
                    </p>
                    <KvGrid>
                      {LOAD_OPTION_LABELS.map(({ key, label }) => (
                        <DetailRow
                          key={key}
                          label={label}
                          value={formatLoadOptionValue(recorded.options[key])}
                        />
                      ))}
                    </KvGrid>
                  </>
                )}
              </Section>
            </>
          )}
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void copyToJson()}
            disabled={loading || !!error}
            title="Zkopírovat všechny parametry jako JSON"
          >
            {copyState === 'ok' ? 'Zkopírováno' : copyState === 'err' ? 'Kopírování selhalo' : 'Copy to JSON'}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Zavřít
          </button>
        </div>
      </div>
    </div>
  )
}
