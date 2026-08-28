import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import {
  api,
  type Preset,
  type PresetDataMap,
  type PresetKind
} from '../types/api'

export interface PresetBarProps<K extends PresetKind> {
  kind: K
  getCurrentData: () => PresetDataMap[K]
  applyData: (data: PresetDataMap[K]) => void
  disabled?: boolean
}

type Status = { type: 'ok' | 'err'; text: string } | null

export default function PresetBar<K extends PresetKind>({
  kind,
  getCurrentData,
  applyData,
  disabled = false
}: PresetBarProps<K>): JSX.Element {
  const { t } = useI18n()
  const [presets, setPresets] = useState<Array<Preset<K>>>([])
  const [selectedId, setSelectedId] = useState('')
  const [status, setStatus] = useState<Status>(null)
  const [busy, setBusy] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')

  const flash = useCallback((type: 'ok' | 'err', text: string): void => {
    setStatus({ type, text })
    window.setTimeout(() => setStatus(null), 2500)
  }, [])

  const refresh = useCallback(async (): Promise<Array<Preset<K>>> => {
    const list = await api().listPresets(kind)
    setPresets(list)
    return list
  }, [kind])

  useEffect(() => {
    void refresh().catch(() => {})
  }, [refresh])

  const selected = presets.find((p) => p.id === selectedId) ?? null

  const handleLoad = (): void => {
    if (!selected) {
      flash('err', t('presets.selectRequired'))
      return
    }
    applyData(selected.data)
    flash('ok', t('presets.loaded', { name: selected.name }))
  }

  const handleSave = async (): Promise<void> => {
    const name = saveName.trim() || selected?.name || ''
    if (!name) {
      flash('err', t('presets.nameRequired'))
      return
    }
    setBusy(true)
    try {
      const overwriteId =
        selected && selected.name.toLowerCase() === name.toLowerCase() ? selected.id : undefined
      const saved = await api().savePreset(kind, name, getCurrentData(), overwriteId)
      const list = await refresh()
      setSelectedId(saved.id)
      if (!list.some((p) => p.id === saved.id)) setSelectedId(saved.id)
      setSaveOpen(false)
      setSaveName('')
      flash('ok', t('presets.saved', { name: saved.name }))
    } catch (e) {
      flash('err', e instanceof Error ? e.message : t('presets.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const handleCopy = async (): Promise<void> => {
    const payload = {
      kind,
      name: selected?.name ?? 'current',
      updatedAt: Date.now(),
      data: getCurrentData()
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      flash('ok', t('presets.copied'))
    } catch {
      flash('err', t('presets.copyFailed'))
    }
  }

  const handleImport = async (): Promise<void> => {
    if (!importText.trim()) {
      flash('err', t('presets.pasteJson'))
      return
    }
    setBusy(true)
    try {
      const imported = await api().importPreset(kind, importText)
      await refresh()
      setSelectedId(imported.id)
      applyData(imported.data)
      setImportOpen(false)
      setImportText('')
      flash('ok', t('presets.imported', { name: imported.name }))
    } catch (e) {
      flash('err', e instanceof Error ? e.message : t('presets.importFailed'))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!selected) {
      flash('err', t('presets.selectRequired'))
      return
    }
    if (!window.confirm(t('presets.deleteConfirm', { name: selected.name }))) return
    setBusy(true)
    try {
      await api().deletePreset(kind, selected.id)
      setSelectedId('')
      await refresh()
      flash('ok', t('presets.deleted'))
    } catch (e) {
      flash('err', e instanceof Error ? e.message : t('presets.deleteFailed'))
    } finally {
      setBusy(false)
    }
  }

  const openSave = (): void => {
    setSaveName(selected?.name ?? '')
    setSaveOpen(true)
  }

  return (
    <div className="preset-bar">
      <div className="preset-bar-row">
        <label className="preset-bar-label" htmlFor={`preset-select-${kind}`}>
          {t('presets.label')}
        </label>
        <select
          id={`preset-select-${kind}`}
          className="preset-select"
          value={selectedId}
          disabled={disabled || busy}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          <option value="">{t('presets.select')}</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="preset-actions">
          <button
            type="button"
            className="btn"
            disabled={disabled || busy || !selectedId}
            onClick={handleLoad}
            title={t('presets.loadTitle')}
          >
            {t('presets.load')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={disabled || busy}
            onClick={openSave}
            title={t('presets.saveTitle')}
          >
            {t('presets.save')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={disabled || busy}
            onClick={() => void handleCopy()}
            title={t('presets.copyTitle')}
          >
            {t('presets.copy')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={disabled || busy}
            onClick={() => setImportOpen(true)}
            title={t('presets.importTitle')}
          >
            {t('presets.import')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={disabled || busy || !selectedId}
            onClick={() => void handleDelete()}
            title={t('presets.deleteTitle')}
          >
            {t('presets.delete')}
          </button>
        </div>
      </div>

      {status && (
        <div className={`preset-status ${status.type === 'ok' ? 'preset-status-ok' : 'preset-status-err'}`}>
          {status.text}
        </div>
      )}

      {saveOpen && (
        <div className="preset-inline-panel">
          <label htmlFor={`preset-save-name-${kind}`}>{t('presets.nameLabel')}</label>
          <div className="preset-inline-row">
            <input
              id={`preset-save-name-${kind}`}
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder={t('presets.namePlaceholder')}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSave()
                if (e.key === 'Escape') setSaveOpen(false)
              }}
            />
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void handleSave()}>
              {t('presets.saveAction')}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setSaveOpen(false)}>
              {t('presets.cancel')}
            </button>
          </div>
        </div>
      )}

      {importOpen && (
        <div className="preset-inline-panel">
          <label htmlFor={`preset-import-${kind}`}>{t('presets.jsonLabel')}</label>
          <textarea
            id={`preset-import-${kind}`}
            className="mono"
            rows={6}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder='{ "kind": "...", "name": "...", "data": { ... } }'
            autoFocus
          />
          <div className="preset-inline-row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void handleImport()}>
              {t('presets.importAction')}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setImportOpen(false)
                setImportText('')
              }}
            >
              {t('presets.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
