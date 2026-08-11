import { useEffect, useState } from 'react'
import { api, type AppConfig, type OllamaEnvConfig, type ServeState } from '../types/api'

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
  LLAMA_ARG_CTX_CHECKPOINTS: '0'
}

export default function Server(): JSX.Element {
  const [config, setConfig] = useState<AppConfig>({ ollamaEnv: { ...EMPTY_ENV }, autoStartServe: true })
  const [serve, setServe] = useState<ServeState | null>(null)
  const [binary, setBinary] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)

  useEffect(() => {
    api().getServerConfig().then(setConfig).catch(() => {})
    api().getServeStatus().then(setServe).catch(() => {})
    api().detectOllamaBinary().then(setBinary).catch(() => {})
  }, [])

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
      <h1 className="page-title">Server</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="metric-label">Ollama binary</div>
        <div className="mono">{binary ?? 'Nenalezeno — nainstalujte Ollama CLI'}</div>
        {serve?.pid && <div className="metric-label" style={{ marginTop: 8 }}>PID serve: {serve.pid}</div>}
      </div>

      <div className="alert alert-info">
        Parametry se ukládají do konfigurace aplikace a při každém spawnu se předají child procesu{' '}
        <code>ollama serve</code>. Nejsou to systémové proměnné Windows.
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
          <label>OLLAMA_CONTEXT_LENGTH</label>
          <input
            value={config.ollamaEnv.OLLAMA_CONTEXT_LENGTH}
            onChange={(e) => updateEnv('OLLAMA_CONTEXT_LENGTH', e.target.value)}
            placeholder="prázdné = výchozí Ollama"
          />
        </div>

        <div className="form-field">
          <label>OLLAMA_KEEP_ALIVE</label>
          <input
            value={config.ollamaEnv.OLLAMA_KEEP_ALIVE}
            onChange={(e) => updateEnv('OLLAMA_KEEP_ALIVE', e.target.value)}
            placeholder="např. 5m"
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
            <option value="">— výchozí —</option>
            <option value="0">0 (vypnuto)</option>
            <option value="1">1 (zapnuto)</option>
          </select>
        </div>

        <div className="form-field">
          <label>OLLAMA_KV_CACHE_TYPE</label>
          <select
            value={config.ollamaEnv.OLLAMA_KV_CACHE_TYPE}
            onChange={(e) => updateEnv('OLLAMA_KV_CACHE_TYPE', e.target.value)}
          >
            <option value="">— výchozí —</option>
            <option value="f16">f16</option>
            <option value="q8_0">q8_0</option>
            <option value="q4_0">q4_0</option>
          </select>
        </div>

        <div className="form-section-title">Diagnostika</div>

        <div className="form-field">
          <label>OLLAMA_DEBUG</label>
          <select
            value={config.ollamaEnv.OLLAMA_DEBUG}
            onChange={(e) => updateEnv('OLLAMA_DEBUG', e.target.value)}
          >
            <option value="1">1 (zapnuto)</option>
            <option value="0">0 (vypnuto)</option>
            <option value="">— výchozí —</option>
          </select>
        </div>

        <div className="form-field">
          <label>OLLAMA_DEBUG_LOG_REQUESTS</label>
          <select
            value={config.ollamaEnv.OLLAMA_DEBUG_LOG_REQUESTS}
            onChange={(e) => updateEnv('OLLAMA_DEBUG_LOG_REQUESTS', e.target.value)}
          >
            <option value="1">1 (zapnuto)</option>
            <option value="0">0 (vypnuto)</option>
            <option value="">— výchozí —</option>
          </select>
        </div>

        <div className="form-field">
          <label>LLAMA_ARG_CTX_CHECKPOINTS</label>
          <select
            value={config.ollamaEnv.LLAMA_ARG_CTX_CHECKPOINTS}
            onChange={(e) => updateEnv('LLAMA_ARG_CTX_CHECKPOINTS', e.target.value)}
          >
            <option value="0">0 (vypnuto)</option>
            <option value="1">1 (zapnuto)</option>
            <option value="">— výchozí —</option>
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
            Automaticky spustit serve při startu aplikace
          </label>
        </div>
      </div>

      <div className="btn-row" style={{ marginTop: 16 }}>
        <button className="btn btn-primary" onClick={() => setConfirmRestart(true)} disabled={saving}>
          Uložit a restartovat serve
        </button>
        <button className="btn" onClick={() => api().startServer().then(setServe)}>
          Spustit
        </button>
        <button className="btn" onClick={() => api().stopServer().then(setServe)}>
          Zastavit
        </button>
        <button className="btn" onClick={() => api().restartServer().then(setServe)}>
          Restartovat
        </button>
      </div>

      {confirmRestart && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Restartovat serve?</h3>
            <p>
              Uloží se nová konfigurace a proces <code>ollama serve</code> se restartuje. Probíhající inference
              budou přerušeny.
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmRestart(false)}>
                Zrušit
              </button>
              <button className="btn btn-primary" onClick={handleSaveAndRestart} disabled={saving}>
                {saving ? 'Ukládám…' : 'Potvrdit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
