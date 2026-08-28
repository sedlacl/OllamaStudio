import { useEffect, useState } from 'react'
import PresetBar from '../components/PresetBar'
import { useI18n } from '../i18n/I18nProvider'
import {
  api,
  type AppConfig,
  type BackendId,
  type OllamaEnvConfig,
  type OllamaUpdateInfo,
  type ServePresetData,
  type ServeState,
  type TabbyConfig,
  type TabbyPreflightResult
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

const DEFAULT_TABBY: TabbyConfig = {
  installDir: 'D:\\AI\\Tabby',
  pythonPath: '',
  configPath: '',
  host: '127.0.0.1',
  port: 5000,
  modelDir: '',
  autoStartServe: false
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

function normalizeTabby(partial?: TabbyConfig | null): TabbyConfig {
  return { ...DEFAULT_TABBY, ...partial }
}

export default function Server(): JSX.Element {
  const { t } = useI18n()
  const [config, setConfig] = useState<AppConfig>({
    ollamaEnv: { ...EMPTY_ENV },
    autoStartServe: true,
    activeBackend: 'ollama',
    tabby: { ...DEFAULT_TABBY }
  })
  const [serve, setServe] = useState<ServeState | null>(null)
  const [binary, setBinary] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [update, setUpdate] = useState<OllamaUpdateInfo | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [switchTarget, setSwitchTarget] = useState<BackendId | null>(null)
  const [switching, setSwitching] = useState(false)
  const [preflight, setPreflight] = useState<TabbyPreflightResult | null>(null)
  const [preflightBusy, setPreflightBusy] = useState(false)

  const activeBackend: BackendId = config.activeBackend === 'tabby' ? 'tabby' : 'ollama'
  const isTabby = activeBackend === 'tabby'

  const refreshBinary = (): void => {
    api().detectOllamaBinary().then(setBinary).catch(() => {})
  }

  useEffect(() => {
    api()
      .getServerConfig()
      .then((cfg) => {
        setConfig({
          ...cfg,
          activeBackend: cfg.activeBackend === 'tabby' ? 'tabby' : 'ollama',
          tabby: normalizeTabby(cfg.tabby)
        })
      })
      .catch(() => {})
    api().getServeStatus().then(setServe).catch(() => {})
    const servePoll = window.setInterval(() => {
      api().getServeStatus().then(setServe).catch(() => {})
    }, 8000)
    refreshBinary()
    api().checkOllamaUpdate().then(setUpdate).catch(() => {})
    return () => window.clearInterval(servePoll)
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

  const updateTabby = <K extends keyof TabbyConfig>(key: K, value: TabbyConfig[K]): void => {
    setConfig((c) => ({
      ...c,
      tabby: { ...normalizeTabby(c.tabby), [key]: value }
    }))
  }

  const handleSaveAndRestart = async (): Promise<void> => {
    setSaving(true)
    try {
      const state = await api().saveServerConfigAndRestart(config)
      setServe(state)
      setConfirmRestart(false)
      refreshBinary()
    } finally {
      setSaving(false)
    }
  }

  const handleSwitchBackend = async (backend: BackendId): Promise<void> => {
    setSwitching(true)
    try {
      const state = await api().switchBackend(backend)
      setServe(state)
      const cfg = await api().getServerConfig()
      setConfig({
        ...cfg,
        activeBackend: cfg.activeBackend === 'tabby' ? 'tabby' : 'ollama',
        tabby: normalizeTabby(cfg.tabby)
      })
      setPreflight(null)
      refreshBinary()
    } finally {
      setSwitching(false)
      setSwitchTarget(null)
    }
  }

  const runPreflight = async (): Promise<void> => {
    setPreflightBusy(true)
    try {
      setPreflight(await api().tabbyPreflight())
    } catch (e) {
      setPreflight({
        ok: false,
        installDir: config.tabby?.installDir ?? '',
        pythonPath: config.tabby?.pythonPath ?? '',
        configPath: config.tabby?.configPath ?? '',
        mainPy: '',
        errors: [e instanceof Error ? e.message : t('server.preflightFailed')],
        warnings: []
      })
    } finally {
      setPreflightBusy(false)
    }
  }

  const binaryDisplay =
    serve?.binaryPath ?? preflight?.pythonPath ?? binary ?? (isTabby ? config.tabby?.pythonPath : null)

  const authFingerprint = serve?.auth

  return (
    <div>
      <h1 className="page-title">{t('server.title')}</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-field">
          <label>{t('server.backendLabel')}</label>
          <div className="btn-row" style={{ gap: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                name="active-backend"
                checked={activeBackend === 'ollama'}
                disabled={switching}
                onChange={() => {
                  if (activeBackend !== 'ollama') setSwitchTarget('ollama')
                }}
              />
              {t('backend.ollama')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                name="active-backend"
                checked={activeBackend === 'tabby'}
                disabled={switching}
                onChange={() => {
                  if (activeBackend !== 'tabby') setSwitchTarget('tabby')
                }}
              />
              {t('backend.tabby')}
            </label>
          </div>
          <span className="field-help">{t('server.backendHint')}</span>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="metric-label">
          {isTabby ? t('server.pythonLabel') : t('server.binaryLabel')}
        </div>
        <div className="mono">{binaryDisplay?.trim() || t('server.binaryMissing')}</div>
        {serve?.pid && (
          <div className="metric-label" style={{ marginTop: 8 }}>
            {t('server.pidServe', { pid: serve.pid })}
          </div>
        )}

        {isTabby && serve?.adoptedExisting && (
          <div className="alert alert-info" style={{ marginTop: 12, marginBottom: 0 }}>
            {t('server.tabbyAdopted', { pid: serve.pid ?? '—' })}
          </div>
        )}
        {isTabby && serve?.processStatus === 'external' && (
          <div className="alert alert-info" style={{ marginTop: 12, marginBottom: 0 }}>
            {t('server.tabbyExternal')}
          </div>
        )}

        {isTabby && authFingerprint && (
          <div style={{ marginTop: 12 }}>
            <div className="metric-label">{t('server.authFingerprint')}</div>
            <ul className="metric-label" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              <li>
                {t('server.authApiKey')}:{' '}
                {authFingerprint.disableAuth
                  ? t('server.authDisabled')
                  : authFingerprint.hasApiKey
                    ? t('server.authConfigured')
                    : t('server.authMissing')}
              </li>
              <li>
                {t('server.authAdminKey')}:{' '}
                {authFingerprint.disableAuth
                  ? t('server.authDisabled')
                  : authFingerprint.hasAdminKey
                    ? t('server.authConfigured')
                    : t('server.authMissing')}
              </li>
              <li>
                {t('server.authDisableFlag')}:{' '}
                {authFingerprint.disableAuth ? t('common.on') : t('common.off')}
              </li>
            </ul>
          </div>
        )}

        {!isTabby && (
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
        )}

        {!isTabby && update?.error && (
          <div className="alert" style={{ marginTop: 12, marginBottom: 0 }}>
            {t('server.updateCheckFailed', { error: update.error })}
          </div>
        )}

        {!isTabby && update && !update.error && update.updateAvailable && (
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

        {!isTabby && update && !update.error && !update.updateAvailable && update.latest && (
          <div className="metric-label" style={{ marginTop: 12 }}>
            {t('server.upToDate')}
          </div>
        )}
      </div>

      <div className="alert alert-info">{isTabby ? t('server.tabbyInfo') : t('server.info')}</div>

      {!isTabby && (
        <>
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
        </>
      )}

      {isTabby && (
        <div className="card form-grid">
          <div className="form-field">
            <label>{t('server.tabbyInstallDir')}</label>
            <input
              value={config.tabby?.installDir ?? ''}
              onChange={(e) => updateTabby('installDir', e.target.value)}
              placeholder={DEFAULT_TABBY.installDir}
            />
          </div>

          <div className="form-field">
            <label>{t('server.tabbyPythonPath')}</label>
            <input
              value={config.tabby?.pythonPath ?? ''}
              onChange={(e) => updateTabby('pythonPath', e.target.value)}
              placeholder={t('server.tabbyPythonPlaceholder')}
            />
          </div>

          <div className="form-field">
            <label>{t('server.tabbyConfigPath')}</label>
            <input
              value={config.tabby?.configPath ?? ''}
              onChange={(e) => updateTabby('configPath', e.target.value)}
              placeholder={t('server.tabbyConfigPlaceholder')}
            />
          </div>

          <div className="form-field">
            <label>{t('server.tabbyHost')}</label>
            <input
              value={config.tabby?.host ?? ''}
              onChange={(e) => updateTabby('host', e.target.value)}
              placeholder="127.0.0.1"
            />
          </div>

          <div className="form-field">
            <label>{t('server.tabbyPort')}</label>
            <input
              type="number"
              min="1"
              max="65535"
              value={config.tabby?.port ?? 5000}
              onChange={(e) => updateTabby('port', Number(e.target.value) || DEFAULT_TABBY.port)}
            />
          </div>

          <div className="form-field">
            <label>{t('server.tabbyModelDir')}</label>
            <input
              value={config.tabby?.modelDir ?? ''}
              onChange={(e) => updateTabby('modelDir', e.target.value)}
              placeholder={t('server.tabbyModelDirPlaceholder')}
            />
          </div>

          <div className="form-field">
            <label>
              <input
                type="checkbox"
                checked={config.tabby?.autoStartServe ?? false}
                onChange={(e) => updateTabby('autoStartServe', e.target.checked)}
                style={{ marginRight: 8 }}
              />
              {t('server.tabbyAutoStart')}
            </label>
          </div>

          <div className="form-field" style={{ gridColumn: '1 / -1' }}>
            <button className="btn" onClick={() => void runPreflight()} disabled={preflightBusy}>
              {preflightBusy ? t('server.preflightRunning') : t('server.preflight')}
            </button>
          </div>

          {preflight && (
            <div className="form-field" style={{ gridColumn: '1 / -1' }}>
              {preflight.ok ? (
                <div className="alert alert-info" style={{ marginBottom: 0 }}>
                  {t('server.preflightOk')}
                </div>
              ) : (
                <div className="alert alert-error" style={{ marginBottom: 0 }}>
                  {t('server.preflightFailedTitle')}
                </div>
              )}
              {preflight.errors.length > 0 && (
                <ul className="mono" style={{ marginTop: 8, color: 'var(--danger)' }}>
                  {preflight.errors.map((msg) => (
                    <li key={msg}>{msg}</li>
                  ))}
                </ul>
              )}
              {preflight.warnings.length > 0 && (
                <>
                  <div className="metric-label" style={{ marginTop: 8 }}>
                    {t('server.preflightWarnings')}
                  </div>
                  <ul className="mono" style={{ marginTop: 4 }}>
                    {preflight.warnings.map((msg) => (
                      <li key={msg}>{msg}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      )}

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
            <p>{isTabby ? t('server.confirmBodyTabby') : t('server.confirmBody')}</p>
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

      {switchTarget && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>{t('server.switchBackendTitle')}</h3>
            <p>
              {t('server.switchBackendBody', {
                backend: switchTarget === 'tabby' ? t('backend.tabby') : t('backend.ollama')
              })}
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setSwitchTarget(null)} disabled={switching}>
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void handleSwitchBackend(switchTarget)}
                disabled={switching}
              >
                {switching ? t('server.switching') : t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
