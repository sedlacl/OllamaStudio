import { useEffect, useMemo, useState } from 'react'
import type { AppConfig, ModelLoadOptions, ModelShow, ModelTag } from '../types/api'

export interface LoadModelDialogProps {
  model: ModelTag
  modelInfo: ModelShow | null
  serverConfig: AppConfig | null
  loading: boolean
  error: string | null
  onCancel: () => void
  onLoad: (options: ModelLoadOptions) => Promise<void>
}

interface LoadForm {
  keepInMemory: boolean
  ttl: string
  numCtx: string
  numBatch: string
  numGpu: string
  numThread: string
  useMmap: boolean
  useMlock: boolean
  ropeBase: string
  ropeScale: string
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function contextLimit(modelInfo: ModelShow | null): number | null {
  const modelInfoValues = modelInfo?.model_info ?? {}
  const direct = numericValue(modelInfoValues.context_length)
  if (direct !== null) return direct

  const entry = Object.entries(modelInfoValues).find(([key]) => key.endsWith('.context_length'))
  return entry ? numericValue(entry[1]) : null
}

function configuredContext(serverConfig: AppConfig | null): number | null {
  return numericValue(serverConfig?.ollamaEnv.OLLAMA_CONTEXT_LENGTH)
}

function initialForm(modelInfo: ModelShow | null, serverConfig: AppConfig | null): LoadForm {
  const limit = contextLimit(modelInfo)
  const configured = configuredContext(serverConfig)
  const context = configured ?? limit

  return {
    keepInMemory: true,
    ttl: '30m',
    numCtx: context !== null ? String(limit !== null ? Math.min(context, limit) : context) : '',
    numBatch: '',
    numGpu: '-1',
    numThread: '',
    useMmap: true,
    useMlock: false,
    ropeBase: '',
    ropeScale: ''
  }
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export default function LoadModelDialog({
  model,
  modelInfo,
  serverConfig,
  loading,
  error,
  onCancel,
  onLoad
}: LoadModelDialogProps): JSX.Element {
  const [form, setForm] = useState<LoadForm>(() => initialForm(modelInfo, serverConfig))
  const [validationError, setValidationError] = useState<string | null>(null)
  const maxContext = contextLimit(modelInfo)
  const serverEnv = serverConfig?.ollamaEnv

  useEffect(() => {
    if (modelInfo || serverConfig) {
      setForm(initialForm(modelInfo, serverConfig))
    }
  }, [modelInfo, serverConfig])

  const modelMeta = useMemo(() => {
    const details = model.details
    return [details?.parameter_size, details?.quantization_level, formatSize(model.size)]
      .filter(Boolean)
      .join(' · ')
  }, [model])

  const update = <K extends keyof LoadForm>(key: K, value: LoadForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }))
    setValidationError(null)
  }

  const submit = async (): Promise<void> => {
    if (!form.keepInMemory && !form.ttl.trim()) {
      setValidationError('Zadejte TTL, nebo zapněte „Keep model in memory“.')
      return
    }

    const numCtx = optionalNumber(form.numCtx)
    const numBatch = optionalNumber(form.numBatch)
    const numGpu = optionalNumber(form.numGpu)
    const numThread = optionalNumber(form.numThread)
    const ropeBase = optionalNumber(form.ropeBase)
    const ropeScale = optionalNumber(form.ropeScale)

    if (form.numCtx.trim() && (numCtx === undefined || numCtx <= 0)) {
      setValidationError('Context Length musí být kladné číslo.')
      return
    }
    if (maxContext !== null && numCtx !== undefined && numCtx > maxContext) {
      setValidationError(`Model podporuje nejvýše ${maxContext.toLocaleString('cs-CZ')} tokenů.`)
      return
    }
    if (form.numBatch.trim() && (numBatch === undefined || numBatch <= 0)) {
      setValidationError('Evaluation Batch Size musí být kladné číslo.')
      return
    }
    if (form.numGpu.trim() && (numGpu === undefined || numGpu < -1)) {
      setValidationError('GPU Offload musí být -1 nebo nezáporné číslo.')
      return
    }
    if (form.numThread.trim() && (numThread === undefined || numThread < 0)) {
      setValidationError('CPU Thread Pool Size musí být nezáporné číslo.')
      return
    }
    if (form.ropeBase.trim() && (ropeBase === undefined || ropeBase <= 0)) {
      setValidationError('RoPE Frequency Base musí být kladné číslo.')
      return
    }
    if (form.ropeScale.trim() && (ropeScale === undefined || ropeScale <= 0)) {
      setValidationError('RoPE Frequency Scale musí být kladné číslo.')
      return
    }

    await onLoad({
      keepAlive: form.keepInMemory ? '-1' : form.ttl.trim(),
      numCtx,
      numBatch,
      numGpu,
      numThread,
      useMmap: form.useMmap,
      useMlock: form.useMlock,
      ropeFrequencyBase: ropeBase,
      ropeFrequencyScale: ropeScale
    })
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal load-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="load-model-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="load-dialog-header">
          <div>
            <h3 id="load-model-title">Načíst model</h3>
            <p className="load-dialog-subtitle">Pokročilé parametry procesu Ollama</p>
          </div>
          <button className="dialog-close" onClick={onCancel} aria-label="Zavřít">
            ×
          </button>
        </div>

        <div className="load-dialog-body">
          <div className="load-memory-estimate">
            <div>
              <span className="load-section-label">Odhad paměti</span>
              <span className="experimental-badge">Beta</span>
            </div>
            <strong>Ollama spočítá skutečnou alokaci při načtení</strong>
            <span>VRAM a paměť procesu ověříte po načtení na Přehledu.</span>
          </div>

          <div className="load-model-file">
            <span className="load-section-label">Model file</span>
            <div className="load-model-pill">
              <strong>{model.name}</strong>
              {modelMeta && <span>{modelMeta}</span>}
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="model-api-identifier">API Identifier</label>
            <input id="model-api-identifier" value={model.name} readOnly />
            <span className="field-help">Identifikátor používaný v API požadavcích.</span>
          </div>

          <div className="load-section">
            <div className="load-section-heading">Načtení modelu</div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="model-auto-unload">Auto Unload if Idle (TTL)</label>
                <span className="field-help">
                  Ollama parametr <code>keep_alive</code> — TTL jako duration (např. <code>30m</code>),
                  jinak číslo (sekundy).
                </span>
              </div>
              <input
                id="model-auto-unload"
                type="checkbox"
                checked={!form.keepInMemory}
                onChange={(event) => update('keepInMemory', !event.target.checked)}
              />
            </div>

            <div className="load-setting-row">
              <label htmlFor="model-ttl">TTL</label>
              <input
                id="model-ttl"
                value={form.ttl}
                disabled={form.keepInMemory}
                onChange={(event) => update('ttl', event.target.value)}
                placeholder="např. 30m"
              />
            </div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="model-context">Context Length</label>
                <span className="field-help">
                  {maxContext !== null
                    ? `Maximum modelu: ${maxContext.toLocaleString('cs-CZ')} tokenů`
                    : 'Ollama option num_ctx'}
                </span>
              </div>
              <input
                id="model-context"
                type="number"
                min="1"
                value={form.numCtx}
                onChange={(event) => update('numCtx', event.target.value)}
              />
            </div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="model-gpu">GPU Offload</label>
                <span className="field-help">Počet vrstev; -1 = automaticky, 0 = CPU.</span>
              </div>
              <input
                id="model-gpu"
                type="number"
                min="-1"
                value={form.numGpu}
                onChange={(event) => update('numGpu', event.target.value)}
              />
            </div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="model-threads">CPU Thread Pool Size</label>
                <span className="field-help">Prázdné = rozhodne runtime.</span>
              </div>
              <input
                id="model-threads"
                type="number"
                min="0"
                value={form.numThread}
                onChange={(event) => update('numThread', event.target.value)}
                placeholder="Auto"
              />
            </div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="model-batch">Evaluation Batch Size</label>
                <span className="field-help">Ollama option num_batch.</span>
              </div>
              <input
                id="model-batch"
                type="number"
                min="1"
                value={form.numBatch}
                onChange={(event) => update('numBatch', event.target.value)}
                placeholder="Výchozí Ollama"
              />
            </div>

            <div className="load-setting-row">
              <div>
                <label>Physical Batch Size</label>
                <span className="field-help">Ollama používá stejný parametr num_batch.</span>
              </div>
              <span className="setting-readonly">Stejné jako Evaluation Batch Size</span>
            </div>
          </div>

          <div className="load-section">
            <div className="load-section-heading">Serverová nastavení</div>
            <SettingStatus label="Max Concurrent Predictions" value={serverEnv?.OLLAMA_NUM_PARALLEL} />
            <SettingStatus label="Unified KV Cache" value={serverEnv?.OLLAMA_KV_CACHE_TYPE} />
            <SettingStatus label="Context Checkpoints" value={serverEnv?.LLAMA_ARG_CTX_CHECKPOINTS} />
            <SettingStatus label="Flash Attention" value={serverEnv?.OLLAMA_FLASH_ATTENTION} />
            <p className="field-help load-section-note">Tyto parametry se nastavují na stránce Server a platí pro celý serve proces.</p>
          </div>

          <div className="load-section">
            <div className="load-section-heading">Pokročilé runner options</div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="model-mmap">Try mmap</label>
                <span className="field-help">Ollama option use_mmap.</span>
              </div>
              <input
                id="model-mmap"
                type="checkbox"
                checked={form.useMmap}
                onChange={(event) => update('useMmap', event.target.checked)}
              />
            </div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="model-mlock">Use mlock</label>
                <span className="field-help">Ollama option use_mlock.</span>
              </div>
              <input
                id="model-mlock"
                type="checkbox"
                checked={form.useMlock}
                onChange={(event) => update('useMlock', event.target.checked)}
              />
            </div>

            <div className="load-setting-row">
              <label htmlFor="model-rope-base">RoPE Frequency Base</label>
              <input
                id="model-rope-base"
                type="number"
                min="0"
                value={form.ropeBase}
                onChange={(event) => update('ropeBase', event.target.value)}
                placeholder="Auto"
              />
            </div>

            <div className="load-setting-row">
              <label htmlFor="model-rope-scale">RoPE Frequency Scale</label>
              <input
                id="model-rope-scale"
                type="number"
                min="0"
                step="0.01"
                value={form.ropeScale}
                onChange={(event) => update('ropeScale', event.target.value)}
                placeholder="Auto"
              />
            </div>

            <SettingStatus label="Offload KV Cache to GPU Memory" value="Řídí Ollama / backend" />
            <SettingStatus label="Seed" value="Platí až pro generování" />
            <SettingStatus label="Speculative Decoding" value="Model/API specific" />
            <SettingStatus label="Chat Template" value="Modelfile TEMPLATE" />
          </div>

          <div className="load-setting-row load-keep-row">
            <div>
              <label htmlFor="model-keep-memory">Keep Model in Memory</label>
              <span className="field-help">
                Při zapnutí se pošle <code>keep_alive</code> jako číslo <code>-1</code> (navždy).
              </span>
            </div>
            <input
              id="model-keep-memory"
              type="checkbox"
              checked={form.keepInMemory}
              onChange={(event) => update('keepInMemory', event.target.checked)}
            />
          </div>

          {(validationError || error) && <div className="alert alert-error">{validationError ?? error}</div>}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={loading}>
            Zrušit
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={loading}>
            {loading ? 'Načítám…' : 'Načíst model'}
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingStatus({ label, value }: { label: string; value?: string }): JSX.Element {
  return (
    <div className="load-setting-row">
      <label>{label}</label>
      <span className="setting-readonly">{value || 'Výchozí Ollama'}</span>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${bytes} B`
}
