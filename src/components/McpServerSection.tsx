import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { api, type McpConfig, type McpRuntimeState, type McpSettingsSnapshot } from '../types/api'
import { buildCursorMcpJsonSnippet } from '../../shared/mcp-cursor-snippet'

function runtimeStatusKey(
  status: McpRuntimeState['status']
): `server.mcp.status${'Stopped' | 'Starting' | 'Listening' | 'Error'}` {
  switch (status) {
    case 'starting':
      return 'server.mcp.statusStarting'
    case 'listening':
      return 'server.mcp.statusListening'
    case 'error':
      return 'server.mcp.statusError'
    default:
      return 'server.mcp.statusStopped'
  }
}

const MCP_PORT_MIN = 1024
const MCP_PORT_MAX = 65535

function parseMcpPort(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const port = Number(value)
  return Number.isSafeInteger(port) && port >= MCP_PORT_MIN && port <= MCP_PORT_MAX
    ? port
    : null
}

export function McpServerSection(): JSX.Element {
  const { t } = useI18n()
  const [snapshot, setSnapshot] = useState<McpSettingsSnapshot | null>(null)
  const [draftEnabled, setDraftEnabled] = useState(false)
  const [draftPort, setDraftPort] = useState(String(3847))
  const [saving, setSaving] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
  const [tokenRevealed, setTokenRevealed] = useState(false)
  const [copyNotice, setCopyNotice] = useState<'token' | 'snippet' | null>(null)
  const initialized = useRef(false)

  const applySnapshot = useCallback((next: McpSettingsSnapshot): void => {
    initialized.current = true
    setSnapshot(next)
    setDraftEnabled(next.settings.enabled)
    setDraftPort(String(next.settings.port))
  }, [])

  const refresh = useCallback((): void => {
    void api()
      .getMcpSettings()
      .then((next) => {
        if (initialized.current) setSnapshot(next)
        else applySnapshot(next)
      })
      .catch(() => {})
  }, [applySnapshot])

  useEffect(() => {
    refresh()
    const poll = window.setInterval(refresh, 5000)
    return () => window.clearInterval(poll)
  }, [refresh])

  const parsedPort = useMemo(() => parseMcpPort(draftPort), [draftPort])
  const portValid = parsedPort !== null

  const dirty = useMemo(() => {
    if (!snapshot) return false
    return draftEnabled !== snapshot.settings.enabled || parsedPort !== snapshot.settings.port
  }, [draftEnabled, parsedPort, snapshot])

  const handleSave = async (): Promise<void> => {
    if (parsedPort === null) return
    setSaving(true)
    try {
      const next = await api().saveMcpSettings({
        enabled: draftEnabled,
        port: parsedPort
      })
      applySnapshot(next)
    } finally {
      setSaving(false)
    }
  }

  const handleRegenerate = async (): Promise<void> => {
    setRegenerating(true)
    try {
      const next = await api().regenerateMcpToken()
      applySnapshot(next)
      setTokenRevealed(true)
      setConfirmRegenerate(false)
    } finally {
      setRegenerating(false)
    }
  }

  const copyText = async (text: string, kind: 'token' | 'snippet'): Promise<void> => {
    await navigator.clipboard.writeText(text)
    setCopyNotice(kind)
    window.setTimeout(() => setCopyNotice(null), 2000)
  }

  const settings: McpConfig | null = snapshot?.settings ?? null
  const runtime = snapshot?.runtime

  const snippet = settings != null ? buildCursorMcpJsonSnippet({ port: settings.port }) : ''

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="form-section-title">{t('server.mcp.sectionTitle')}</div>
      <p className="field-help" style={{ marginBottom: 12 }}>
        {t('server.mcp.hint')}
      </p>

      <div className="form-field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={draftEnabled}
            onChange={(e) => setDraftEnabled(e.target.checked)}
            disabled={saving}
          />
          {t('server.mcp.enabled')}
        </label>
      </div>

      <div className="form-field">
        <label htmlFor="mcp-port">{t('server.mcp.port')}</label>
        <input
          id="mcp-port"
          type="number"
          min={MCP_PORT_MIN}
          max={MCP_PORT_MAX}
          value={draftPort}
          onChange={(e) => setDraftPort(e.target.value)}
          disabled={saving}
        />
        {!portValid && draftPort.trim() !== '' && (
          <span className="field-help field-help-error">{t('server.mcp.portInvalid')}</span>
        )}
      </div>

      <div className="form-field">
        <span className="metric-label">{t('server.mcp.status')}</span>
        <div>
          {runtime ? t(runtimeStatusKey(runtime.status)) : '—'}
          {runtime?.status === 'error' && runtime.error ? (
            <span className="field-help field-help-error"> ({runtime.error})</span>
          ) : null}
        </div>
      </div>

      {settings && (
        <div className="form-field">
          <label htmlFor="mcp-token">{t('server.mcp.token')}</label>
          <p className="field-help" style={{ marginBottom: 8 }}>
            {t('server.mcp.tokenHelp')}
          </p>
          <div className="btn-row" style={{ alignItems: 'stretch', flexWrap: 'wrap' }}>
            <input
              id="mcp-token"
              className="mono"
              readOnly
              type={tokenRevealed ? 'text' : 'password'}
              value={tokenRevealed ? settings.token : '••••••••••••••••'}
              style={{ flex: 1, minWidth: 200 }}
            />
            <button type="button" className="btn" onClick={() => setTokenRevealed((v) => !v)}>
              {tokenRevealed ? t('server.mcp.hideToken') : t('server.mcp.showToken')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void copyText(settings.token, 'token')}
            >
              {copyNotice === 'token' ? t('server.mcp.tokenCopied') : t('server.mcp.copyToken')}
            </button>
            <button type="button" className="btn" onClick={() => setConfirmRegenerate(true)}>
              {t('server.mcp.regenerateToken')}
            </button>
          </div>
        </div>
      )}

      {settings && (
        <div className="form-field">
          <span className="metric-label">{t('server.mcp.cursorSnippet')}</span>
          <p className="field-help" style={{ marginBottom: 8 }}>
            {t('server.mcp.cursorSnippetHelp')}
          </p>
          <pre className="mono" style={{ maxHeight: 160, overflow: 'auto', fontSize: 12 }}>
            {snippet}
          </pre>
          <button type="button" className="btn" onClick={() => void copyText(snippet, 'snippet')}>
            {copyNotice === 'snippet'
              ? t('server.mcp.snippetCopied')
              : t('server.mcp.copyCursorSnippet')}
          </button>
        </div>
      )}

      <div className="btn-row" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty || !portValid || saving}
          onClick={() => void handleSave()}
        >
          {saving ? t('server.mcp.saving') : t('server.mcp.save')}
        </button>
      </div>

      {confirmRegenerate && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>{t('server.mcp.regenerateConfirmTitle')}</h3>
            <p>{t('server.mcp.regenerateConfirmBody')}</p>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setConfirmRegenerate(false)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={regenerating}
                onClick={() => void handleRegenerate()}
              >
                {regenerating ? t('server.mcp.saving') : t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
