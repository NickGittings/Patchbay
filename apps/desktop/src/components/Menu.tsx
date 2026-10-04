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
 * press elsewhere, focus leaving it, the window losing focus, or Escape. While open it holds
 * focus, so keys never reach a terminal underneath; on close focus returns to where it was (the
 * trigger, when the menu was opened from the keyboard). With `keepMounted` the list stays
 * rendered (hidden) while closed, so items that load state, like extension `when` contexts, are
 * ready when it opens.
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
  // `keyboard`: opened with Enter/Space/arrows, so the first item takes focus.
  const [open, setOpen] = useState<false | { keyboard: boolean }>(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // What had focus when the trigger was pressed, read before the press moves focus.
  const pressedFrom = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    const el = root.current
    const previous = open.keyboard ? null : pressedFrom.current
    pressedFrom.current = null
    if (open.keyboard) items(list.current)[0]?.focus()
    else list.current?.focus()
    // A press outside closes the menu without swallowing it, so the next control still gets it;
    // presses in frames or other windows only blur this one.
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onBlur = () => setOpen(false)
    // If the focused item went away (an attention item resolved), focus is nowhere, so the menu
    // root no longer hears keys; listening on the window then takes nothing from anyone.
    const onStrandedKey = (e: globalThis.KeyboardEvent) => {
      if (document.activeElement !== document.body) return
      if (e.key === 'Escape') setOpen(false)
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') items(list.current)[0]?.focus()
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onStrandedKey)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onStrandedKey)
      // However the menu closed or unmounted: if focus is left in it (hidden now) or nowhere,
      // return it to where it was, or to the trigger when opened from the keyboard. Focus the
      // user moved elsewhere stays put.
      const active = document.activeElement
      const stranded = !active || active === document.body || !!el?.contains(active)
      if (!stranded) return
      if (previous?.isConnected && !previous.closest('.menu-list')) previous.focus()
      else if (open.keyboard) trigger.current?.focus()
    }
  }, [open])

  const close = () => setOpen(false)

  // Keys are handled only while focus is in the menu, so they're never taken from anything else.
  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' && e.target === trigger.current) {
        e.preventDefault()
        setOpen({ keyboard: true })
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
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

  return (
    <div
      className={`menu ${className}`}
      ref={root}
      onKeyDown={onKey}
      onBlur={(e) => {
        // Focus moved to another control (Tab, or the command palette opening). A click that
        // leaves no element focused is handled by the pointerdown listener instead.
        if (e.relatedTarget && !root.current?.contains(e.relatedTarget)) close()
      }}
    >
      <button
        ref={trigger}
        className={`menu-trigger ${triggerClassName}`}
        aria-haspopup="menu"
        aria-expanded={!!open}
        title={title}
        onPointerDown={() => {
          const active = document.activeElement
          pressedFrom.current =
            active instanceof HTMLElement && active !== document.body && !active.closest('.menu')
              ? active
              : null
        }}
        // `detail` is 0 when the click came from Enter or Space.
        onClick={(e) => (open ? close() : setOpen({ keyboard: e.detail === 0 }))}
      >
        {label}
        {caret && (
          <span className="menu-caret" aria-hidden>
            ▾
          </span>
        )}
      </button>
      {(open || keepMounted) && (
        <div
          ref={list}
          className={`menu-list ${align} ${listClassName}`}
          role="menu"
          tabIndex={-1}
          hidden={!open}
        >
          <CloseMenu.Provider value={close}>{children}</CloseMenu.Provider>
        </div>
      )}
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
        // Closing restores focus when React commits, so an item that moves focus later (a
        // revealed terminal, a frame on) has the last word.
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
