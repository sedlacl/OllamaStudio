import { useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'

export interface OverflowAction {
  id: string
  label: string
  title?: string
  danger?: boolean
  disabled?: boolean
  separatorBefore?: boolean
  onClick: () => void
}

export default function ModelOverflowMenu({
  modelName,
  actions
}: {
  modelName: string
  actions: OverflowAction[]
}): JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const visible = actions.filter((action) => action.label)

  return (
    <div className="model-overflow" ref={rootRef}>
      <button
        type="button"
        className="btn btn-icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t('models.moreActionsAria', { name: modelName })}
        title={t('models.moreActions')}
        onClick={() => setOpen((prev) => !prev)}
      >
        ⋯
      </button>
      {open && (
        <div className="model-overflow-menu" id={menuId} role="menu">
          {visible.map((action) => (
            <div key={action.id}>
              {action.separatorBefore && <div className="model-overflow-sep" />}
              <button
                type="button"
                role="menuitem"
                className={`model-overflow-item${action.danger ? ' is-danger' : ''}`}
                disabled={action.disabled}
                title={action.title}
                onClick={() => {
                  setOpen(false)
                  action.onClick()
                }}
              >
                {action.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
