import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import type {
  AppConfig,
  LoadPresetData,
  MmapPreference,
  ModelLoadOptions,
  ModelShow,
  ModelTag
} from '../types/api'
import PresetBar from './PresetBar'

export interface LoadModelDialogProps {
  model: ModelTag
  modelInfo: ModelShow | null
  serverConfig: AppConfig | null
  loading: boolean
  error: string | null
  onCancel: () => void
  onLoad: (options: ModelLoadOptions) => void
}

interface LoadForm {
  keepInMemory: boolean
  ttl: string
  numCtx: string
  numBatch: string
  numGpu: string
  numThread: string
  useMmap: MmapPreference
  useMlock: boolean
  ropeBase: string
  ropeScale: string
}

function formToPreset(form: LoadForm): LoadPresetData {
  return { ...form }
}

function mmapFromPreset(value: MmapPreference | boolean | undefined): MmapPreference {
  if (value === true) return 'on'
  if (value === false) return 'off'
  return value ?? 'auto'
}

function presetToForm(data: LoadPresetData): LoadForm {
  return {
    keepInMemory: !!data.keepInMemory,
    ttl: data.ttl ?? '30m',
    numCtx: data.numCtx ?? '',
    numBatch: data.numBatch ?? '',
    numGpu: data.numGpu ?? '-1',
    numThread: data.numThread ?? '',
    useMmap: mmapFromPreset(data.useMmap),
    useMlock: !!data.useMlock,
    ropeBase: data.ropeBase ?? '',
    ropeScale: data.ropeScale ?? ''
  }
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

function parseModelfileParam(parameters: string | undefined, key: string): number | null {
  if (!parameters) return null
  const match = parameters.match(new RegExp(`(?:^|\\n)\\s*${key}\\s+(\\S+)`, 'i'))
  return match ? numericValue(match[1]) : null
}

function initialTtl(serverConfig: AppConfig | null): string {
  const fromServer = serverConfig?.ollamaEnv.OLLAMA_KEEP_ALIVE?.trim()
  return fromServer || '30m'
}

function effectiveNumCtx(modelInfo: ModelShow | null, serverConfig: AppConfig | null): number | null {
  const limit = contextLimit(modelInfo)
  const preferred =
    parseModelfileParam(modelInfo?.parameters, 'num_ctx') ??
    configuredContext(serverConfig) ??
    limit
  if (preferred === null) return null
  return limit !== null ? Math.min(preferred, limit) : preferred
}

function initialForm(modelInfo: ModelShow | null, serverConfig: AppConfig | null): LoadForm {
  const context = effectiveNumCtx(modelInfo, serverConfig)

  return {
    keepInMemory: true,
    ttl: initialTtl(serverConfig),
    numCtx: context !== null ? String(context) : '',
    numBatch: '',
    numGpu: '-1',
    numThread: '',
    useMmap: 'auto',
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
  const { t, formatNumber } = useI18n()
  const [form, setForm] = useState<LoadForm>(() => initialForm(modelInfo, serverConfig))
  const [validationError, setValidationError] = useState<string | null>(null)
  const maxContext = contextLimit(modelInfo)
  const serverCtx = configuredContext(serverConfig)
  const modelfileCtx = parseModelfileParam(modelInfo?.parameters, 'num_ctx')
  const serverEnv = serverConfig?.ollamaEnv
  const keepAliveSent = form.keepInMemory ? '-1' : form.ttl.trim() || '—'

  useEffect(() => {
    if (modelInfo || serverConfig) {
      setForm(initialForm(modelInfo, serverConfig))
    }
  }, [modelInfo, serverConfig])

  const modelMeta = useMemo(() => {
    const details = model.details
    return [
      details?.parameter_size,
      details?.quantization_level,
      `${formatSize(model.size)} ${t('loadDialog.onDisk')}`
    ]
      .filter(Boolean)
      .join(' · ')
  }, [model, t])

  const update = <K extends keyof LoadForm>(key: K, value: LoadForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }))
    setValidationError(null)
  }

  const submit = (): void => {
    if (!form.keepInMemory && !form.ttl.trim()) {
      setValidationError(t('loadDialog.errTtl'))
      return
    }

    const numCtx = optionalNumber(form.numCtx)
    const numBatch = optionalNumber(form.numBatch)
    const numGpu = optionalNumber(form.numGpu)
    const numThread = optionalNumber(form.numThread)
    const ropeBase = optionalNumber(form.ropeBase)
    const ropeScale = optionalNumber(form.ropeScale)

    if (form.numCtx.trim() && (numCtx === undefined || numCtx <= 0)) {
      setValidationError(t('loadDialog.errContext'))
      return
    }
    if (maxContext !== null && numCtx !== undefined && numCtx > maxContext) {
      setValidationError(t('loadDialog.errContextMax', { max: formatNumber(maxContext) }))
      return
    }
    if (form.numBatch.trim() && (numBatch === undefined || numBatch <= 0)) {
      setValidationError(t('loadDialog.errBatch'))
      return
    }
    if (form.numGpu.trim() && (numGpu === undefined || numGpu < -1)) {
      setValidationError(t('loadDialog.errGpu'))
      return
    }
    if (form.numThread.trim() && (numThread === undefined || numThread < 0)) {
      setValidationError(t('loadDialog.errThreads'))
      return
    }
    if (form.ropeBase.trim() && (ropeBase === undefined || ropeBase <= 0)) {
      setValidationError(t('loadDialog.errRopeBase'))
      return
    }
    if (form.ropeScale.trim() && (ropeScale === undefined || ropeScale <= 0)) {
      setValidationError(t('loadDialog.errRopeScale'))
      return
    }

    onLoad({
      keepAlive: form.keepInMemory ? '-1' : form.ttl.trim(),
      numCtx,
      numBatch,
      numGpu,
      numThread,
      useMmap: form.useMmap === 'auto' ? undefined : form.useMmap === 'on',
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
            <h3 id="load-model-title">{t('loadDialog.title')}</h3>
            <p className="load-dialog-subtitle">{t('loadDialog.subtitle')}</p>
          </div>
          <button className="dialog-close" onClick={onCancel} aria-label={t('loadDialog.closeAria')}>
            ×
          </button>
        </div>

        <div className="load-dialog-body">
          <PresetBar
            kind="load"
            disabled={loading}
            getCurrentData={() => formToPreset(form)}
            applyData={(data) => {
              setForm(presetToForm(data))
              setValidationError(null)
            }}
          />

          <div className="load-memory-estimate">
            <div>
              <span className="load-section-label">{t('loadDialog.memoryEstimate')}</span>
              <span className="experimental-badge">{t('loadDialog.beta')}</span>
            </div>
            <strong>{t('loadDialog.memoryCalc')}</strong>
            <span>{t('loadDialog.memoryHint')}</span>
          </div>

          <div className="load-model-file">
            <span className="load-section-label">{t('loadDialog.modelFile')}</span>
            <div className="load-model-pill">
              <strong>{model.name}</strong>
              {modelMeta && <span>{modelMeta}</span>}
            </div>
            <span className="field-help">{t('loadDialog.modelMetaHelp')}</span>
          </div>

          <div className="form-field">
            <label htmlFor="model-api-identifier">{t('loadDialog.apiIdentifier')}</label>
            <input id="model-api-identifier" value={model.name} readOnly />
            <span className="field-help">{t('loadDialog.apiIdentifierHelp')}</span>
          </div>

          <div className="load-section">
            <div className="load-section-heading">{t('loadDialog.sectionLoad')}</div>

            <p className="load-subsection-label">{t('loadDialog.keepAliveMode')}</p>

            <div className="load-setting-row">
              <div>
                <label htmlFor="model-keep-forever">{t('loadDialog.keepForever')}</label>
                <span className="field-help">{t('loadDialog.keepForeverHelp')}</span>
              </div>
              <input
                id="model-keep-forever"
                type="radio"
                name="keep-alive-mode"
                checked={form.keepInMemory}
                onChange={() => update('keepInMemory', true)}
              />
            </div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="model-auto-unload">{t('loadDialog.autoUnload')}</label>
                <span className="field-help">{t('loadDialog.autoUnloadHelp')}</span>
              </div>
              <input
                id="model-auto-unload"
                type="radio"
                name="keep-alive-mode"
                checked={!form.keepInMemory}
                onChange={() => update('keepInMemory', false)}
              />
            </div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="model-ttl">{t('loadDialog.ttl')}</label>
                <span className="field-help">
                  {form.keepInMemory
                    ? t('loadDialog.ttlInactive')
                    : t('loadDialog.autoUnloadHelp')}
                </span>
              </div>
              {form.keepInMemory ? (
                <span className="setting-readonly">{t('loadDialog.ttlInactive')}</span>
              ) : (
                <input
                  id="model-ttl"
                  value={form.ttl}
                  onChange={(event) => update('ttl', event.target.value)}
                  placeholder={t('loadDialog.ttlPlaceholder')}
                />
              )}
            </div>

            <p className="field-help load-will-send">
              {t('loadDialog.keepAliveWillSend', { value: keepAliveSent })}
            </p>

            <div className="load-setting-row">
              <div>
                <label htmlFor="model-context">{t('loadDialog.contextLength')}</label>
                <span className="field-help">{t('loadDialog.contextHelp')}</span>
                {maxContext !== null && (
                  <span className="field-help">
                    {t('loadDialog.contextMax', { max: formatNumber(maxContext) })}
                  </span>
                )}
                {modelfileCtx !== null && (
                  <span className="field-help">
                    {t('loadDialog.contextModelfile', { value: formatNumber(modelfileCtx) })}
                  </span>
                )}
                {serverCtx !== null && (
                  <span className="field-help">
                    {t('loadDialog.contextServer', { value: formatNumber(serverCtx) })}
                  </span>
                )}
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
                <label htmlFor="model-gpu">{t('loadDialog.gpuOffload')}</label>
                <span className="field-help">{t('loadDialog.gpuOffloadHelp')}</span>
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
                <label htmlFor="model-threads">{t('loadDialog.cpuThreads')}</label>
                <span className="field-help">{t('loadDialog.cpuThreadsHelp')}</span>
              </div>
              <input
                id="model-threads"
                type="number"
                min="0"
                value={form.numThread}
                onChange={(event) => update('numThread', event.target.value)}
                placeholder={t('common.auto')}
              />
            </div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="model-batch">{t('loadDialog.batchSize')}</label>
                <span className="field-help">{t('loadDialog.batchHelp')}</span>
              </div>
              <input
                id="model-batch"
                type="number"
                min="1"
                value={form.numBatch}
                onChange={(event) => update('numBatch', event.target.value)}
                placeholder={t('loadDialog.batchPlaceholder')}
              />
            </div>

            <div className="load-setting-row">
              <div>
                <label>{t('loadDialog.physicalBatch')}</label>
                <span className="field-help">{t('loadDialog.physicalBatchHelp')}</span>
              </div>
              <span className="setting-readonly">{t('loadDialog.physicalBatchSame')}</span>
            </div>
          </div>

          <div className="load-section">
            <div className="load-section-heading">{t('loadDialog.serverSettings')}</div>
            <SettingStatus label={t('loadDialog.maxConcurrent')} value={serverEnv?.OLLAMA_NUM_PARALLEL} />
            <SettingStatus label={t('loadDialog.unifiedKv')} value={serverEnv?.OLLAMA_KV_CACHE_TYPE} />
            <SettingStatus label={t('loadDialog.contextCheckpoints')} value={serverEnv?.LLAMA_ARG_CTX_CHECKPOINTS} />
            <SettingStatus label={t('loadDialog.flashAttention')} value={serverEnv?.OLLAMA_FLASH_ATTENTION} />
            <SettingStatus
              label={t('loadDialog.serverKeepAlive')}
              value={serverEnv?.OLLAMA_KEEP_ALIVE}
            />
            <SettingStatus
              label={t('loadDialog.serverContextLength')}
              value={serverEnv?.OLLAMA_CONTEXT_LENGTH}
            />
            <p className="field-help load-section-note">{t('loadDialog.serverNote')}</p>
          </div>

          <div className="load-section">
            <div className="load-section-heading">{t('loadDialog.advanced')}</div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="model-mmap">{t('loadDialog.tryMmap')}</label>
                <span className="field-help">{t('loadDialog.tryMmapHelp')}</span>
              </div>
              <select
                id="model-mmap"
                value={form.useMmap}
                onChange={(event) => update('useMmap', event.target.value as MmapPreference)}
              >
                <option value="auto">{t('loadDialog.mmapAuto')}</option>
                <option value="on">{t('loadDialog.mmapOn')}</option>
                <option value="off">{t('loadDialog.mmapOff')}</option>
              </select>
            </div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="model-mlock">{t('loadDialog.useMlock')}</label>
                <span className="field-help">{t('loadDialog.useMlockHelp')}</span>
              </div>
              <input
                id="model-mlock"
                type="checkbox"
                checked={form.useMlock}
                onChange={(event) => update('useMlock', event.target.checked)}
              />
            </div>

            <div className="load-setting-row">
              <label htmlFor="model-rope-base">{t('loadDialog.ropeBase')}</label>
              <input
                id="model-rope-base"
                type="number"
                min="0"
                value={form.ropeBase}
                onChange={(event) => update('ropeBase', event.target.value)}
                placeholder={t('common.auto')}
              />
            </div>

            <div className="load-setting-row">
              <label htmlFor="model-rope-scale">{t('loadDialog.ropeScale')}</label>
              <input
                id="model-rope-scale"
                type="number"
                min="0"
                step="0.01"
                value={form.ropeScale}
                onChange={(event) => update('ropeScale', event.target.value)}
                placeholder={t('common.auto')}
              />
            </div>

            <SettingStatus label={t('loadDialog.offloadKv')} value={t('loadDialog.offloadKvValue')} />
            <SettingStatus label={t('loadDialog.seed')} value={t('loadDialog.seedValue')} />
            <SettingStatus label={t('loadDialog.speculative')} value={t('loadDialog.speculativeValue')} />
            <SettingStatus label={t('loadDialog.chatTemplate')} value={t('loadDialog.chatTemplateValue')} />
          </div>

          {(validationError || error) && <div className="alert alert-error">{validationError ?? error}</div>}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={loading}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={loading}>
            {t('loadDialog.loadAction')}
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingStatus({ label, value }: { label: string; value?: string }): JSX.Element {
  const { t } = useI18n()
  return (
    <div className="load-setting-row">
      <label>{label}</label>
      <span className="setting-readonly">{value || t('common.defaultOllama')}</span>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${bytes} B`
}
