import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

const CloseMenu = createContext<() => void>(() => {})

const items = (list: HTMLElement | null) =>
  Array.from(list?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])

/**
 * A toolbar dropdown: a trigger button and a list of `MenuItem`s that closes on any choice, a
 * press elsewhere, focus leaving it, the window losing focus, or Escape. With `keepMounted` the
 * list stays rendered (hidden) while closed, so items that load state, like extension `when`
 * contexts, are ready when it opens.
 */
export default function Menu({
  label,
  title,
  align = 'left',
  className = '',
  triggerClassName = '',
  listClassName = '',
  caret = true,
  keepMounted = false,
  children,
}: {
  label: ReactNode
  title?: string
  align?: 'left' | 'right'
  className?: string
  triggerClassName?: string
  listClassName?: string
  caret?: boolean
  keepMounted?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    items(list.current)[0]?.focus()
    // A press outside closes the menu without swallowing it, so the next control still gets it;
    // presses in frames or other windows only blur this one.
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onBlur = () => setOpen(false)
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const closeToTrigger = () => {
    setOpen(false)
    trigger.current?.focus()
  }

  // Keys are handled only while focus is inside the list, so they never reach a terminal
  // underneath and never steal them from anything else.
  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeToTrigger()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      const all = items(list.current)
      if (!all.length) return
      const at = all.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        e.key === 'ArrowDown'
          ? (at + 1) % all.length
          : at < 0
            ? all.length - 1
            : (at - 1 + all.length) % all.length
      all[next].focus()
    }
  }

  const listElement = (
    <div
      ref={list}
      className={`menu-list ${align} ${listClassName}`}
      role="menu"
      hidden={!open}
      onKeyDown={onListKey}
    >
      <CloseMenu.Provider value={closeToTrigger}>{children}</CloseMenu.Provider>
    </div>
  )

  return (
    <div
      className={`menu ${className}`}
      ref={root}
      onBlur={(e) => {
        // Focus moved to another control (Tab, or the command palette opening). A click that
        // leaves no element focused is handled by the pointerdown listener instead.
        if (e.relatedTarget && !root.current?.contains(e.relatedTarget)) setOpen(false)
      }}
    >
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
      {(open || keepMounted) && listElement}
    </div>
  )
}

/** A menu entry; `className` replaces the default `menu-item` look for custom rows. */
export function MenuItem({
  onClick,
  shortcut,
  title,
  className = 'menu-item',
  children,
  ...rest
}: {
  onClick: () => void
  shortcut?: string
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
      title={title}
      onClick={() => {
        // Close first, so an item that moves focus (revealing a terminal) has the last word.
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
