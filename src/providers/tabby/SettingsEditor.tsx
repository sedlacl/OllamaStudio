import { useI18n } from '../../i18n/I18nProvider'
import type { TabbySettingsEditorProps } from '../types'
import { DEFAULT_TABBY_CONFIG } from './defaults'

export default function TabbySettingsEditor({
  config,
  preflight,
  preflightBusy,
  onConfigChange,
  onRunPreflight
}: TabbySettingsEditorProps): JSX.Element {
  const { t } = useI18n()

  return (
    <div className="card form-grid">
      <div className="form-field">
        <label>{t('server.tabbyInstallDir')}</label>
        <input
          value={config.installDir ?? ''}
          onChange={(e) => onConfigChange('installDir', e.target.value)}
          placeholder={DEFAULT_TABBY_CONFIG.installDir}
        />
      </div>

      <div className="form-field">
        <label>{t('server.tabbyPythonPath')}</label>
        <input
          value={config.pythonPath ?? ''}
          onChange={(e) => onConfigChange('pythonPath', e.target.value)}
          placeholder={t('server.tabbyPythonPlaceholder')}
        />
      </div>

      <div className="form-field">
        <label>{t('server.tabbyConfigPath')}</label>
        <input
          value={config.configPath ?? ''}
          onChange={(e) => onConfigChange('configPath', e.target.value)}
          placeholder={t('server.tabbyConfigPlaceholder')}
        />
      </div>

      <div className="form-field">
        <label>{t('server.tabbyHost')}</label>
        <input
          value={config.host ?? ''}
          onChange={(e) => onConfigChange('host', e.target.value)}
          placeholder="127.0.0.1"
        />
      </div>

      <div className="form-field">
        <label>{t('server.tabbyPort')}</label>
        <input
          type="number"
          min="1"
          max="65535"
          value={config.port ?? DEFAULT_TABBY_CONFIG.port}
          onChange={(e) => onConfigChange('port', Number(e.target.value) || DEFAULT_TABBY_CONFIG.port)}
        />
      </div>

      <div className="form-field">
        <label>{t('server.tabbyModelDir')}</label>
        <input
          value={config.modelDir ?? ''}
          onChange={(e) => onConfigChange('modelDir', e.target.value)}
          placeholder={t('server.tabbyModelDirPlaceholder')}
        />
      </div>

      <div className="form-field">
        <label>
          <input
            type="checkbox"
            checked={config.autoStartServe ?? false}
            onChange={(e) => onConfigChange('autoStartServe', e.target.checked)}
            style={{ marginRight: 8 }}
          />
          {t('server.tabbyAutoStart')}
        </label>
      </div>

      <div className="form-field" style={{ gridColumn: '1 / -1' }}>
        <button className="btn" onClick={() => void onRunPreflight()} disabled={preflightBusy}>
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
  )
}
