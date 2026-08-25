import { useEffect, useState } from 'react'
import PresetBar from '../components/PresetBar'
import { useI18n } from '../i18n/I18nProvider'
import {
  api,
  type AppConfig,
  type OllamaEnvConfig,
  type OllamaUpdateInfo,
  type ServePresetData,
  type ServeState
} from '../types/api'

const EMPTY_ENV: OllamaEnvConfig = {
  OLLAMA_HOST: '127.0.0.1:11434',
  OLLAMA_CONTEXT_LENGTH: '131072',
  OLLAMA_KEEP_ALIVE: '30m',
  OLLAMA_MAX_LOADED_MODELS: '',
  OLLAMA_NUM_PARALLEL: '1',
  OLLAMA_FLASH_ATTENTION: '1',
  OLLAMA_KV_CACHE_TYPE: 'q8_0',
  OLLAMA_DEBUG: '1',
  OLLAMA_DEBUG_LOG_REQUESTS: '1',
  LLAMA_ARG_CTX_CHECKPOINTS: '0',
  OLLAMA_MODELS: ''
}

function configToPreset(config: AppConfig): ServePresetData {
  return {
    ollamaEnv: { ...config.ollamaEnv },
    autoStartServe: config.autoStartServe
  }
}

function applyServePreset(data: ServePresetData, current: AppConfig): AppConfig {
  return {
    ...current,
    ollamaEnv: { ...EMPTY_ENV, ...data.ollamaEnv },
    autoStartServe: data.autoStartServe ?? true
  }
}

export default function Server(): JSX.Element {
  const { t } = useI18n()
  const [config, setConfig] = useState<AppConfig>({
    ollamaEnv: { ...EMPTY_ENV },
    autoStartServe: true
  })
  const [serve, setServe] = useState<ServeState | null>(null)
  const [binary, setBinary] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [update, setUpdate] = useState<OllamaUpdateInfo | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)

  useEffect(() => {
    api().getServerConfig().then(setConfig).catch(() => {})
    api().getServeStatus().then(setServe).catch(() => {})
    api().detectOllamaBinary().then(setBinary).catch(() => {})
    api().checkOllamaUpdate().then(setUpdate).catch(() => {})
  }, [])

  const checkUpdate = async (): Promise<void> => {
    setCheckingUpdate(true)
    try {
      setUpdate(await api().checkOllamaUpdate(true))
    } catch {
      /* chybu vrací i samotný výsledek v poli error */
    } finally {
      setCheckingUpdate(false)
    }
  }

  const updateEnv = (key: keyof OllamaEnvConfig, value: string): void => {
    setConfig((c) => ({ ...c, ollamaEnv: { ...c.ollamaEnv, [key]: value } }))
  }

  const handleSaveAndRestart = async (): Promise<void> => {
    setSaving(true)
    try {
      const state = await api().saveServerConfigAndRestart(config)
      setServe(state)
      setConfirmRestart(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <h1 className="page-title">{t('server.title')}</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="metric-label">{t('server.binaryLabel')}</div>
        <div className="mono">{binary ?? t('server.binaryMissing')}</div>
        {serve?.pid && (
          <div className="metric-label" style={{ marginTop: 8 }}>
            {t('server.pidServe', { pid: serve.pid })}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <div>
            <div className="metric-label">{t('server.versionLabel')}</div>
            <div className="mono">
              {update?.current ?? t('server.versionUnknown')}
              {update?.latest && (
                <span className="metric-label" style={{ margin: 0 }}>
                  {' '}
                  · {t('server.latestVersion', { version: update.latest })}
                </span>
              )}
            </div>
          </div>
          <button className="btn" onClick={checkUpdate} disabled={checkingUpdate}>
            {checkingUpdate ? t('server.checking') : t('server.checkUpdate')}
          </button>
        </div>

        {update?.error && (
          <div className="alert" style={{ marginTop: 12, marginBottom: 0 }}>
            {t('server.updateCheckFailed', { error: update.error })}
          </div>
        )}

        {update && !update.error && update.updateAvailable && (
          <div className="alert" style={{ marginTop: 12, marginBottom: 0 }}>
            {t('server.updateAvailable', {
              latest: update.latest ?? '',
              current: update.current ?? '?'
            })}{' '}
            <a
              href={update.releaseUrl}
              onClick={(e) => {
                e.preventDefault()
                void api().openExternal(update.releaseUrl)
              }}
            >
              {t('server.openRelease')}
            </a>
          </div>
        )}

        {update && !update.error && !update.updateAvailable && update.latest && (
          <div className="metric-label" style={{ marginTop: 12 }}>
            {t('server.upToDate')}
          </div>
        )}
      </div>

      <div className="alert alert-info">{t('server.info')}</div>

      <div className="card" style={{ marginBottom: 16 }}>
        <PresetBar
          kind="serve"
          disabled={saving}
          getCurrentData={() => configToPreset(config)}
          applyData={(data) => setConfig((current) => applyServePreset(data, current))}
        />
      </div>

      <div className="card form-grid">
        <div className="form-field">
          <label>OLLAMA_HOST</label>
          <input
            value={config.ollamaEnv.OLLAMA_HOST}
            onChange={(e) => updateEnv('OLLAMA_HOST', e.target.value)}
            placeholder="127.0.0.1:11434"
          />
        </div>

        <div className="form-field">
          <label>OLLAMA_MODELS</label>
          <input
            value={config.ollamaEnv.OLLAMA_MODELS}
            onChange={(e) => updateEnv('OLLAMA_MODELS', e.target.value)}
            placeholder={t('server.modelsPlaceholder')}
          />
        </div>

        <div className="form-field">
          <label>OLLAMA_CONTEXT_LENGTH</label>
          <input
            value={config.ollamaEnv.OLLAMA_CONTEXT_LENGTH}
            onChange={(e) => updateEnv('OLLAMA_CONTEXT_LENGTH', e.target.value)}
            placeholder={t('server.contextPlaceholder')}
          />
        </div>

        <div className="form-field">
          <label>OLLAMA_KEEP_ALIVE</label>
          <input
            value={config.ollamaEnv.OLLAMA_KEEP_ALIVE}
            onChange={(e) => updateEnv('OLLAMA_KEEP_ALIVE', e.target.value)}
            placeholder={t('server.keepAlivePlaceholder')}
          />
        </div>

        <div className="form-field">
          <label>OLLAMA_MAX_LOADED_MODELS</label>
          <input
            value={config.ollamaEnv.OLLAMA_MAX_LOADED_MODELS}
            onChange={(e) => updateEnv('OLLAMA_MAX_LOADED_MODELS', e.target.value)}
          />
        </div>

        <div className="form-field">
          <label>OLLAMA_NUM_PARALLEL</label>
          <input
            value={config.ollamaEnv.OLLAMA_NUM_PARALLEL}
            onChange={(e) => updateEnv('OLLAMA_NUM_PARALLEL', e.target.value)}
          />
        </div>

        <div className="form-field">
          <label>OLLAMA_FLASH_ATTENTION</label>
          <select
            value={config.ollamaEnv.OLLAMA_FLASH_ATTENTION}
            onChange={(e) => updateEnv('OLLAMA_FLASH_ATTENTION', e.target.value)}
          >
            <option value="">{t('common.defaultOption')}</option>
            <option value="0">{t('server.flashOff')}</option>
            <option value="1">{t('server.flashOn')}</option>
          </select>
        </div>

        <div className="form-field">
          <label>OLLAMA_KV_CACHE_TYPE</label>
          <select
            value={config.ollamaEnv.OLLAMA_KV_CACHE_TYPE}
            onChange={(e) => updateEnv('OLLAMA_KV_CACHE_TYPE', e.target.value)}
          >
            <option value="">{t('common.defaultOption')}</option>
            <option value="f16">f16</option>
            <option value="q8_0">q8_0</option>
            <option value="q4_0">q4_0</option>
          </select>
        </div>

        <div className="form-section-title">{t('server.diagnostics')}</div>

        <div className="form-field">
          <label>OLLAMA_DEBUG</label>
          <select
            value={config.ollamaEnv.OLLAMA_DEBUG}
            onChange={(e) => updateEnv('OLLAMA_DEBUG', e.target.value)}
          >
            <option value="1">{t('server.flashOn')}</option>
            <option value="0">{t('server.flashOff')}</option>
            <option value="">{t('common.defaultOption')}</option>
          </select>
        </div>

        <div className="form-field">
          <label>OLLAMA_DEBUG_LOG_REQUESTS</label>
          <select
            value={config.ollamaEnv.OLLAMA_DEBUG_LOG_REQUESTS}
            onChange={(e) => updateEnv('OLLAMA_DEBUG_LOG_REQUESTS', e.target.value)}
          >
            <option value="1">{t('server.flashOn')}</option>
            <option value="0">{t('server.flashOff')}</option>
            <option value="">{t('common.defaultOption')}</option>
          </select>
        </div>

        <div className="form-field">
          <label>LLAMA_ARG_CTX_CHECKPOINTS</label>
          <select
            value={config.ollamaEnv.LLAMA_ARG_CTX_CHECKPOINTS}
            onChange={(e) => updateEnv('LLAMA_ARG_CTX_CHECKPOINTS', e.target.value)}
          >
            <option value="0">{t('server.flashOff')}</option>
            <option value="1">{t('server.flashOn')}</option>
            <option value="">{t('common.defaultOption')}</option>
          </select>
        </div>

        <div className="form-field">
          <label>
            <input
              type="checkbox"
              checked={config.autoStartServe}
              onChange={(e) => setConfig((c) => ({ ...c, autoStartServe: e.target.checked }))}
              style={{ marginRight: 8 }}
            />
            {t('server.autoStart')}
          </label>
        </div>
      </div>

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
            <p>{t('server.confirmBody')}</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmRestart(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" onClick={handleSaveAndRestart} disabled={saving}>
                {saving ? t('server.saving') : t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
