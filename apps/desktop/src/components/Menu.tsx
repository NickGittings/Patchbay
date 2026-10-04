import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

const CloseMenu = createContext<() => void>(() => {})

/** A toolbar dropdown: a trigger button and a list of `MenuItem`s that closes on any choice. */
export default function Menu({
  label,
  title,
  align = 'left',
  triggerClassName = '',
  listClassName = '',
  caret = true,
  children,
}: {
  label: ReactNode
  title?: string
  align?: 'left' | 'right'
  triggerClassName?: string
  listClassName?: string
  caret?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    // Capture and stop Escape so a focused terminal underneath doesn't also receive it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  return (
    <div className="menu">
      <button
        className={`menu-trigger ${triggerClassName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen(!open)}
      >
        {label}
        {caret && (
          <span className="menu-caret" aria-hidden>
            ▾
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="menu-overlay" onClick={() => setOpen(false)} />
          <div className={`menu-list ${align} ${listClassName}`} role="menu">
            <CloseMenu.Provider value={() => setOpen(false)}>{children}</CloseMenu.Provider>
          </div>
        </>
      )}
    </div>
  )
}

/** A menu entry; `className` replaces the default `menu-item` look for custom rows. */
export function MenuItem({
  onClick,
  shortcut,
  disabled,
  title,
  className = 'menu-item',
  children,
  ...rest
}: {
  onClick: () => void
  shortcut?: string
  disabled?: boolean
  title?: string
  className?: string
  children: ReactNode
  'data-extension-command'?: string
}) {
  const close = useContext(CloseMenu)
  return (
    <button
      {...rest}
      role="menuitem"
      className={className}
      disabled={disabled}
      title={title}
      onClick={() => {
        close()
        onClick()
      }}
    >
      {children}
      {shortcut && <kbd className="menu-shortcut">{shortcut}</kbd>}
    </button>
  )
}

export function MenuSeparator() {
  return <div className="menu-separator" role="separator" />
}
