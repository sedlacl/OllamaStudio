import { useEffect, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { useBackendProviders } from '../providers/BackendProviderContext'
import { providerDisplayNameById } from '../providers/i18n-helpers'
import {
  api,
  type ModelLoadOptions,
  type ModelShow,
  type RecordedLoadOptions,
  type RunningModel
} from '../types/api'
import type { ModelRef } from '../../shared/backend-contract'

export interface LoadedModelDetailsDialogProps {
  modelRef: ModelRef
  onClose: () => void
}

function formatBytes(bytes: number | undefined | null, unavailable: string): string {
  if (bytes == null || !Number.isFinite(bytes)) return unavailable
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${bytes} B`
}

function formatValue(value: unknown, unavailable: string): string {
  if (value === undefined || value === null || value === '') return unavailable
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : unavailable
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.length ? value.map(String).join(', ') : unavailable
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
  modelRef,
  onClose
}: LoadedModelDetailsDialogProps): JSX.Element {
  const { t, formatNumber, formatDateTime } = useI18n()
  const { renderSlot, descriptorsById, getDefinition } = useBackendProviders()
  const unavailable = t('details.unavailable')
  const modelName = modelRef.modelId
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState<RunningModel | null>(null)
  const [show, setShow] = useState<ModelShow | null>(null)
  const [recorded, setRecorded] = useState<RecordedLoadOptions | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle')
  const [backendSettings, setBackendSettings] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const descriptor = descriptorsById[modelRef.providerId]
        const [ps, showData, loadOpts, settings] = await Promise.all([
          api().getModelsPs(),
          descriptor?.acquisition === 'ollama-library'
            ? api().modelShow(modelName).catch(() => null)
            : Promise.resolve(null),
          api().getModelLoadOptions(modelRef),
          api().getBackendSettings(modelRef.providerId).catch(() => null)
        ])
        if (cancelled) return
        setRunning(findRunningModel(ps, modelName))
        setShow(showData)
        setBackendSettings(settings)
        setRecorded(loadOpts)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : t('details.loadFailed'))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [modelName, modelRef, descriptorsById, t])

  const details = running?.details
  const providerLabel = providerDisplayNameById(t, modelRef.providerId, descriptorsById)
  const hasModelDetailsSlot = Boolean(getDefinition(modelRef.providerId)?.ModelDetails)

  const copyToJson = async (): Promise<void> => {
    const payload = {
      modelRef,
      exportedAt: new Date().toISOString(),
      runtime: running,
      model: show,
      backendSettings,
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
            <h3 id="loaded-model-details-title">{t('details.title')}</h3>
            <p className="load-dialog-subtitle mono">
              {providerLabel} · {modelName}
            </p>
          </div>
          <button className="dialog-close" onClick={onClose} aria-label={t('details.closeAria')}>
            ×
          </button>
        </div>

        <div className="load-dialog-body detail-dialog-body">
          {loading && <p className="empty-state">{t('details.loading')}</p>}
          {error && <div className="alert alert-error">{error}</div>}

          {!loading && !error && (
            <>
              <Section title={t('details.runtimeTitle')} sourceNote={t('details.runtimeNote')}>
                {!running ? (
                  <p className="detail-unavailable">{t('details.notInPs')}</p>
                ) : (
                  <KvGrid>
                    <DetailRow label="name" value={formatValue(running.name, unavailable)} />
                    <DetailRow label="model" value={formatValue(running.model, unavailable)} />
                    <DetailRow label="digest" value={formatValue(running.digest, unavailable)} />
                    <DetailRow
                      label={t('details.runtimeSize')}
                      value={formatBytes(running.size, unavailable)}
                      unavailable={running.size == null}
                    />
                    <DetailRow
                      label={t('details.runtimeSizeVram')}
                      value={formatBytes(running.size_vram, unavailable)}
                      unavailable={running.size_vram == null}
                    />
                    <DetailRow
                      label={t('details.runtimeCtx')}
                      value={
                        running.context_length != null
                          ? formatNumber(running.context_length)
                          : unavailable
                      }
                      unavailable={running.context_length == null}
                    />
                    <DetailRow label="expires_at" value={formatValue(running.expires_at, unavailable)} />
                    <DetailRow
                      label="details.format"
                      value={formatValue(details?.format, unavailable)}
                      unavailable={!details?.format}
                    />
                    <DetailRow
                      label="details.family"
                      value={formatValue(details?.family, unavailable)}
                      unavailable={!details?.family}
                    />
                    <DetailRow
                      label="details.parameter_size"
                      value={formatValue(details?.parameter_size, unavailable)}
                      unavailable={!details?.parameter_size}
                    />
                    <DetailRow
                      label="details.quantization_level"
                      value={formatValue(details?.quantization_level, unavailable)}
                      unavailable={!details?.quantization_level}
                    />
                  </KvGrid>
                )}
                <p className="detail-epistemic-note">{t('details.runtimeSizeNote')}</p>
              </Section>

              {hasModelDetailsSlot &&
                renderSlot(modelRef.providerId, 'ModelDetails', {
                  modelId: modelName,
                  show,
                  config: backendSettings
                })}

              <Section title={t('details.loadOptsTitle')} sourceNote={t('details.loadOptsNote')}>
                {!recorded ? (
                  <p className="detail-unavailable">{t('details.loadOptsMissing')}</p>
                ) : (
                  <>
                    <p className="detail-meta mono">
                      {t('details.recordedAt', {
                        time: formatDateTime(recorded.recordedAt),
                        name: recorded.modelName
                      })}
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
            title={t('details.copyJsonTitle')}
          >
            {copyState === 'ok'
              ? t('details.copyOk')
              : copyState === 'err'
                ? t('details.copyErr')
                : t('details.copyJson')}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
