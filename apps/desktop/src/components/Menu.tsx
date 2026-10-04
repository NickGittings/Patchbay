import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

const CloseMenu = createContext<() => void>(() => {})

const items = (list: HTMLElement | null) =>
  Array.from(list?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])

/**
 * A toolbar dropdown: a trigger button and a list of `MenuItem`s that closes on any choice, a
 * click elsewhere, or Escape. The list stays mounted while closed, so items that load state
 * (extension `when` contexts) are ready when it opens.
 */
export default function Menu({
  label,
  title,
  align = 'left',
  className = '',
  triggerClassName = '',
  listClassName = '',
  caret = true,
  children,
}: {
  label: ReactNode
  title?: string
  align?: 'left' | 'right'
  className?: string
  triggerClassName?: string
  listClassName?: string
  caret?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    items(list.current)[0]?.focus()
    // A press outside closes the menu without swallowing it, so the next control still gets it.
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    // Captured and stopped so a focused terminal underneath doesn't also receive the keys.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        trigger.current?.focus()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const all = items(list.current)
        if (!all.length) return
        e.preventDefault()
        e.stopPropagation()
        const at = all.indexOf(document.activeElement as HTMLButtonElement)
        const step = e.key === 'ArrowDown' ? 1 : -1
        all[(at + step + all.length) % all.length].focus()
      }
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div className={`menu ${className}`} ref={root}>
      <button
        ref={trigger}
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
      <div ref={list} className={`menu-list ${align} ${listClassName}`} role="menu" hidden={!open}>
        <CloseMenu.Provider value={() => setOpen(false)}>{children}</CloseMenu.Provider>
      </div>
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
