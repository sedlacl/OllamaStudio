import { useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import type { ModelTag, TabbyLoadOptions, TabbyLoadPresetData } from '../types/api'
import PresetBar from './PresetBar'

export interface LoadTabbyDialogProps {
  model: ModelTag
  loading: boolean
  error: string | null
  /** Jiný model než ten, který se právě načítá — Tabby drží jen jeden. */
  currentLoadedId?: string | null
  onCancel: () => void
  onLoad: (options: TabbyLoadOptions) => void
}

interface TabbyLoadForm {
  maxSeqLen: string
  cacheSize: string
  cacheMode: string
  tensorParallel: boolean
  gpuSplitAuto: boolean
  gpuSplit: string
  chunkSize: string
  outputChunking: boolean
  vision: boolean
  mtpEnabled: boolean
  draftNumTokens: string
}

const CACHE_MODES = ['FP16', 'Q8', 'Q6', 'Q4'] as const

function initialForm(): TabbyLoadForm {
  return {
    maxSeqLen: '8192',
    cacheSize: '8192',
    cacheMode: 'FP16',
    tensorParallel: true,
    gpuSplitAuto: true,
    gpuSplit: '',
    chunkSize: '',
    outputChunking: false,
    vision: false,
    mtpEnabled: false,
    draftNumTokens: '4'
  }
}

function formToPreset(form: TabbyLoadForm): TabbyLoadPresetData {
  return { ...form }
}

function presetToForm(data: TabbyLoadPresetData): TabbyLoadForm {
  return {
    maxSeqLen: data.maxSeqLen ?? '',
    cacheSize: data.cacheSize ?? '',
    cacheMode: data.cacheMode ?? 'FP16',
    tensorParallel: !!data.tensorParallel,
    gpuSplitAuto: data.gpuSplitAuto ?? true,
    gpuSplit: data.gpuSplit ?? '',
    chunkSize: data.chunkSize ?? '',
    outputChunking: !!data.outputChunking,
    vision: !!data.vision,
    mtpEnabled: !!data.mtpEnabled,
    draftNumTokens: data.draftNumTokens ?? '4'
  }
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseGpuSplit(value: string): number[] | undefined {
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) return undefined
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return undefined
  return nums
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '—'
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${bytes} B`
}

export default function LoadTabbyDialog({
  model,
  loading,
  error,
  currentLoadedId,
  onCancel,
  onLoad
}: LoadTabbyDialogProps): JSX.Element {
  const { t } = useI18n()
  const [form, setForm] = useState<TabbyLoadForm>(initialForm)
  const [validationError, setValidationError] = useState<string | null>(null)

  const modelMeta = [
    model.details?.parameter_size,
    model.details?.quantization_level,
    `${formatSize(model.size)} ${t('loadDialog.onDisk')}`
  ]
    .filter(Boolean)
    .join(' · ')

  const update = <K extends keyof TabbyLoadForm>(key: K, value: TabbyLoadForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }))
    setValidationError(null)
  }

  const submit = (): void => {
    const maxSeqLen = optionalNumber(form.maxSeqLen)
    const cacheSize = optionalNumber(form.cacheSize)
    const chunkSize = optionalNumber(form.chunkSize)
    const draftNumTokens = optionalNumber(form.draftNumTokens)

    if (form.maxSeqLen.trim() && (maxSeqLen === undefined || maxSeqLen <= 0)) {
      setValidationError(t('loadTabbyDialog.errMaxSeqLen'))
      return
    }
    if (form.cacheSize.trim() && (cacheSize === undefined || cacheSize <= 0)) {
      setValidationError(t('loadTabbyDialog.errCacheSize'))
      return
    }
    if (form.chunkSize.trim() && (chunkSize === undefined || chunkSize <= 0)) {
      setValidationError(t('loadTabbyDialog.errChunkSize'))
      return
    }
    if (!form.gpuSplitAuto && form.gpuSplit.trim()) {
      const split = parseGpuSplit(form.gpuSplit)
      if (!split) {
        setValidationError(t('loadTabbyDialog.errGpuSplit'))
        return
      }
    }
    if (form.mtpEnabled && form.draftNumTokens.trim()) {
      if (draftNumTokens === undefined || draftNumTokens <= 0) {
        setValidationError(t('loadTabbyDialog.errDraftTokens'))
        return
      }
    }

    const gpuSplit = !form.gpuSplitAuto ? parseGpuSplit(form.gpuSplit) : undefined

    onLoad({
      modelName: model.name,
      maxSeqLen,
      cacheSize,
      cacheMode: form.cacheMode || undefined,
      tensorParallel: form.tensorParallel,
      gpuSplitAuto: form.gpuSplitAuto,
      gpuSplit,
      chunkSize,
      outputChunking: form.outputChunking,
      vision: form.vision,
      mtp: form.mtpEnabled
        ? {
            enabled: true,
            draftNumTokens: draftNumTokens ?? 4
          }
        : { enabled: false }
    })
  }

  const showReplaceWarning =
    currentLoadedId != null && currentLoadedId !== '' && currentLoadedId !== model.name

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal load-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="load-tabby-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="load-dialog-header">
          <div>
            <h3 id="load-tabby-title">{t('loadTabbyDialog.title')}</h3>
            <p className="load-dialog-subtitle">{t('loadTabbyDialog.subtitle')}</p>
          </div>
          <button className="dialog-close" onClick={onCancel} aria-label={t('loadDialog.closeAria')}>
            ×
          </button>
        </div>

        <div className="load-dialog-body">
          {showReplaceWarning && (
            <div className="alert alert-info">{t('loadTabbyDialog.replaceWarning', { name: currentLoadedId })}</div>
          )}

          <PresetBar
            kind="tabby-load"
            disabled={loading}
            getCurrentData={() => formToPreset(form)}
            applyData={(data) => {
              setForm(presetToForm(data))
              setValidationError(null)
            }}
          />

          <div className="load-model-file">
            <span className="load-section-label">{t('loadDialog.modelFile')}</span>
            <div className="load-model-pill">
              <strong>{model.name}</strong>
              {modelMeta && <span>{modelMeta}</span>}
            </div>
          </div>

          <div className="load-section">
            <div className="load-section-heading">{t('loadTabbyDialog.sectionContext')}</div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="tabby-max-seq-len">{t('loadTabbyDialog.maxSeqLen')}</label>
                <span className="field-help">{t('loadTabbyDialog.maxSeqLenHelp')}</span>
              </div>
              <input
                id="tabby-max-seq-len"
                type="number"
                min="1"
                value={form.maxSeqLen}
                onChange={(e) => update('maxSeqLen', e.target.value)}
              />
            </div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="tabby-cache-size">{t('loadTabbyDialog.cacheSize')}</label>
                <span className="field-help">{t('loadTabbyDialog.cacheSizeHelp')}</span>
              </div>
              <input
                id="tabby-cache-size"
                type="number"
                min="1"
                value={form.cacheSize}
                onChange={(e) => update('cacheSize', e.target.value)}
              />
            </div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="tabby-cache-mode">{t('loadTabbyDialog.cacheMode')}</label>
                <span className="field-help">{t('loadTabbyDialog.cacheModeHelp')}</span>
              </div>
              <select
                id="tabby-cache-mode"
                value={form.cacheMode}
                onChange={(e) => update('cacheMode', e.target.value)}
              >
                {CACHE_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="load-section">
            <div className="load-section-heading">{t('loadTabbyDialog.sectionGpu')}</div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="tabby-tensor-parallel">{t('loadTabbyDialog.tensorParallel')}</label>
                <span className="field-help">{t('loadTabbyDialog.tensorParallelHelp')}</span>
              </div>
              <input
                id="tabby-tensor-parallel"
                type="checkbox"
                checked={form.tensorParallel}
                onChange={(e) => update('tensorParallel', e.target.checked)}
              />
            </div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="tabby-gpu-split-auto">{t('loadTabbyDialog.gpuSplitAuto')}</label>
                <span className="field-help">{t('loadTabbyDialog.gpuSplitAutoHelp')}</span>
              </div>
              <input
                id="tabby-gpu-split-auto"
                type="checkbox"
                checked={form.gpuSplitAuto}
                onChange={(e) => update('gpuSplitAuto', e.target.checked)}
              />
            </div>

            {!form.gpuSplitAuto && (
              <div className="load-setting-row">
                <div>
                  <label htmlFor="tabby-gpu-split">{t('loadTabbyDialog.gpuSplit')}</label>
                  <span className="field-help">{t('loadTabbyDialog.gpuSplitHelp')}</span>
                </div>
                <input
                  id="tabby-gpu-split"
                  value={form.gpuSplit}
                  onChange={(e) => update('gpuSplit', e.target.value)}
                  placeholder={t('loadTabbyDialog.gpuSplitPlaceholder')}
                />
              </div>
            )}
          </div>

          <div className="load-section">
            <div className="load-section-heading">{t('loadTabbyDialog.sectionAdvanced')}</div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="tabby-chunk-size">{t('loadTabbyDialog.chunkSize')}</label>
                <span className="field-help">{t('loadTabbyDialog.chunkSizeHelp')}</span>
              </div>
              <input
                id="tabby-chunk-size"
                type="number"
                min="1"
                value={form.chunkSize}
                onChange={(e) => update('chunkSize', e.target.value)}
                placeholder={t('common.auto')}
              />
            </div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="tabby-output-chunking">{t('loadTabbyDialog.outputChunking')}</label>
                <span className="field-help">{t('loadTabbyDialog.outputChunkingHelp')}</span>
              </div>
              <input
                id="tabby-output-chunking"
                type="checkbox"
                checked={form.outputChunking}
                onChange={(e) => update('outputChunking', e.target.checked)}
              />
            </div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="tabby-vision">{t('loadTabbyDialog.vision')}</label>
                <span className="field-help">{t('loadTabbyDialog.visionHelp')}</span>
              </div>
              <input
                id="tabby-vision"
                type="checkbox"
                checked={form.vision}
                onChange={(e) => update('vision', e.target.checked)}
              />
            </div>
          </div>

          <div className="load-section">
            <div className="load-section-heading">{t('loadTabbyDialog.sectionMtp')}</div>

            <div className="load-setting-row">
              <div>
                <label htmlFor="tabby-mtp">{t('loadTabbyDialog.mtpEnabled')}</label>
                <span className="field-help">{t('loadTabbyDialog.mtpEnabledHelp')}</span>
              </div>
              <input
                id="tabby-mtp"
                type="checkbox"
                checked={form.mtpEnabled}
                onChange={(e) => update('mtpEnabled', e.target.checked)}
              />
            </div>

            {form.mtpEnabled && (
              <div className="load-setting-row">
                <div>
                  <label htmlFor="tabby-draft-tokens">{t('loadTabbyDialog.draftNumTokens')}</label>
                  <span className="field-help">{t('loadTabbyDialog.draftNumTokensHelp')}</span>
                </div>
                <input
                  id="tabby-draft-tokens"
                  type="number"
                  min="1"
                  value={form.draftNumTokens}
                  onChange={(e) => update('draftNumTokens', e.target.value)}
                />
              </div>
            )}
          </div>

          {(validationError || error) && <div className="alert alert-error">{validationError ?? error}</div>}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={loading}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={loading}>
            {t('loadTabbyDialog.loadAction')}
          </button>
        </div>
      </div>
    </div>
  )
}
