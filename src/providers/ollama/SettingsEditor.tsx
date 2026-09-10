import PresetBar from '../../components/PresetBar'
import { useI18n } from '../../i18n/I18nProvider'
import type { OllamaEnvConfig } from '../../../shared/backend-contract'
import type { OllamaSettingsEditorProps } from '../types'
import { EMPTY_OLLAMA_ENV } from './defaults'

function configToPreset(config: { ollamaEnv: OllamaEnvConfig; autoStartServe: boolean }) {
  return {
    ollamaEnv: { ...config.ollamaEnv },
    autoStartServe: config.autoStartServe
  }
}

export default function OllamaSettingsEditor({
  ollamaEnv,
  autoStartServe,
  saving,
  onEnvChange,
  onAutoStartChange,
  onApplyServePreset
}: OllamaSettingsEditorProps): JSX.Element {
  const { t } = useI18n()

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <PresetBar
          kind="serve"
          disabled={saving}
          getCurrentData={() => configToPreset({ ollamaEnv, autoStartServe })}
          applyData={(data) =>
            onApplyServePreset({
              ollamaEnv: { ...EMPTY_OLLAMA_ENV, ...data.ollamaEnv },
              autoStartServe: data.autoStartServe ?? true
            })
          }
        />
      </div>

      <div className="card form-grid">
        <div className="form-field">
          <label>OLLAMA_HOST</label>
          <input
            value={ollamaEnv.OLLAMA_HOST}
            onChange={(e) => onEnvChange('OLLAMA_HOST', e.target.value)}
            placeholder="127.0.0.1:11434"
          />
        </div>

        <div className="form-field">
          <label>OLLAMA_MODELS</label>
          <input
            value={ollamaEnv.OLLAMA_MODELS}
            onChange={(e) => onEnvChange('OLLAMA_MODELS', e.target.value)}
            placeholder={t('server.modelsPlaceholder')}
          />
        </div>

        <div className="form-field">
          <label>OLLAMA_MAX_LOADED_MODELS</label>
          <input
            value={ollamaEnv.OLLAMA_MAX_LOADED_MODELS}
            onChange={(e) => onEnvChange('OLLAMA_MAX_LOADED_MODELS', e.target.value)}
          />
        </div>

        <div className="form-field">
          <label>OLLAMA_NUM_PARALLEL</label>
          <input
            value={ollamaEnv.OLLAMA_NUM_PARALLEL}
            onChange={(e) => onEnvChange('OLLAMA_NUM_PARALLEL', e.target.value)}
          />
        </div>

        <div className="form-field">
          <label>OLLAMA_FLASH_ATTENTION</label>
          <select
            value={ollamaEnv.OLLAMA_FLASH_ATTENTION}
            onChange={(e) => onEnvChange('OLLAMA_FLASH_ATTENTION', e.target.value)}
          >
            <option value="">{t('common.defaultOption')}</option>
            <option value="0">{t('server.flashOff')}</option>
            <option value="1">{t('server.flashOn')}</option>
          </select>
        </div>

        <div className="form-field">
          <label>OLLAMA_KV_CACHE_TYPE</label>
          <select
            value={ollamaEnv.OLLAMA_KV_CACHE_TYPE}
            onChange={(e) => onEnvChange('OLLAMA_KV_CACHE_TYPE', e.target.value)}
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
            value={ollamaEnv.OLLAMA_DEBUG}
            onChange={(e) => onEnvChange('OLLAMA_DEBUG', e.target.value)}
          >
            <option value="1">{t('server.flashOn')}</option>
            <option value="0">{t('server.flashOff')}</option>
            <option value="">{t('common.defaultOption')}</option>
          </select>
        </div>

        <div className="form-field">
          <label>OLLAMA_DEBUG_LOG_REQUESTS</label>
          <select
            value={ollamaEnv.OLLAMA_DEBUG_LOG_REQUESTS}
            onChange={(e) => onEnvChange('OLLAMA_DEBUG_LOG_REQUESTS', e.target.value)}
          >
            <option value="1">{t('server.flashOn')}</option>
            <option value="0">{t('server.flashOff')}</option>
            <option value="">{t('common.defaultOption')}</option>
          </select>
        </div>

        <div className="form-field">
          <label>LLAMA_ARG_CTX_CHECKPOINTS</label>
          <select
            value={ollamaEnv.LLAMA_ARG_CTX_CHECKPOINTS}
            onChange={(e) => onEnvChange('LLAMA_ARG_CTX_CHECKPOINTS', e.target.value)}
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
              checked={autoStartServe}
              onChange={(e) => onAutoStartChange(e.target.checked)}
              style={{ marginRight: 8 }}
            />
            {t('server.autoStart')}
          </label>
        </div>
      </div>
    </>
  )
}
