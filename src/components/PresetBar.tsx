import { useCallback, useEffect, useState } from 'react'
import {
  api,
  type Preset,
  type PresetDataMap,
  type PresetKind
} from '../types/api'

export interface PresetBarProps<K extends PresetKind> {
  kind: K
  /** Aktuální hodnoty formuláře / konfigurace k uložení a kopírování */
  getCurrentData: () => PresetDataMap[K]
  /** Aplikovat data presetu do formuláře */
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
      flash('err', 'Vyberte preset')
      return
    }
    applyData(selected.data)
    flash('ok', `Načteno: ${selected.name}`)
  }

  const handleSave = async (): Promise<void> => {
    const name = saveName.trim() || selected?.name || ''
    if (!name) {
      flash('err', 'Zadejte název presetu')
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
      flash('ok', `Uloženo: ${saved.name}`)
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Uložení selhalo')
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
      flash('ok', 'Zkopírováno do schránky')
    } catch {
      flash('err', 'Kopírování selhalo')
    }
  }

  const handleImport = async (): Promise<void> => {
    if (!importText.trim()) {
      flash('err', 'Vložte JSON')
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
      flash('ok', `Importováno: ${imported.name}`)
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Import selhal')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!selected) {
      flash('err', 'Vyberte preset')
      return
    }
    if (!window.confirm(`Smazat preset „${selected.name}“?`)) return
    setBusy(true)
    try {
      await api().deletePreset(kind, selected.id)
      setSelectedId('')
      await refresh()
      flash('ok', 'Preset smazán')
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Smazání selhalo')
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
          Preset
        </label>
        <select
          id={`preset-select-${kind}`}
          className="preset-select"
          value={selectedId}
          disabled={disabled || busy}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          <option value="">— vyberte —</option>
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
            title="Načíst vybraný preset do formuláře"
          >
            Load
          </button>
          <button
            type="button"
            className="btn"
            disabled={disabled || busy}
            onClick={openSave}
            title="Uložit aktuální hodnoty jako preset (JSON)"
          >
            Save
          </button>
          <button
            type="button"
            className="btn"
            disabled={disabled || busy}
            onClick={() => void handleCopy()}
            title="Zkopírovat aktuální hodnoty jako JSON"
          >
            Copy
          </button>
          <button
            type="button"
            className="btn"
            disabled={disabled || busy}
            onClick={() => setImportOpen(true)}
            title="Importovat preset z JSON"
          >
            Import
          </button>
          <button
            type="button"
            className="btn"
            disabled={disabled || busy || !selectedId}
            onClick={() => void handleDelete()}
            title="Smazat vybraný preset"
          >
            Delete
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
          <label htmlFor={`preset-save-name-${kind}`}>Název presetu</label>
          <div className="preset-inline-row">
            <input
              id={`preset-save-name-${kind}`}
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="např. 128k-full-gpu"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSave()
                if (e.key === 'Escape') setSaveOpen(false)
              }}
            />
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void handleSave()}>
              Uložit
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setSaveOpen(false)}>
              Zrušit
            </button>
          </div>
        </div>
      )}

      {importOpen && (
        <div className="preset-inline-panel">
          <label htmlFor={`preset-import-${kind}`}>JSON presetu</label>
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
              Importovat
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
              Zrušit
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
