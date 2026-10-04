import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

const CloseMenu = createContext<() => void>(() => {})

/** A toolbar dropdown: a trigger button and a list of `MenuItem`s that closes on any choice. */
export default function Menu({
  label,
  title,
  align = 'left',
  children,
}: {
  label: ReactNode
  title?: string
  align?: 'left' | 'right'
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="menu">
      <button
        className="menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen(!open)}
      >
        {label}
        <span className="menu-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <>
          <div className="menu-overlay" onClick={() => setOpen(false)} />
          <div className={`menu-list ${align}`} role="menu">
            <CloseMenu.Provider value={() => setOpen(false)}>{children}</CloseMenu.Provider>
          </div>
        </>
      )}
    </div>
  )
}

export function MenuItem({
  onClick,
  shortcut,
  disabled,
  title,
  children,
  ...rest
}: {
  onClick: () => void
  shortcut?: string
  disabled?: boolean
  title?: string
  children: ReactNode
  'data-extension-command'?: string
}) {
  const close = useContext(CloseMenu)
  return (
    <button
      {...rest}
      role="menuitem"
      className="menu-item"
      disabled={disabled}
      title={title}
      onClick={() => {
        close()
        onClick()
      }}
    >
      <span className="menu-item-label">{children}</span>
      {shortcut && <kbd className="menu-shortcut">{shortcut}</kbd>}
    </button>
  )
}

export function MenuSeparator() {
  return <div className="menu-separator" role="separator" />
}
