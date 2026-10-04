import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
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
  const previous = useRef<HTMLElement | null>(null)
  // What had focus when the trigger was pressed, read before the press moves focus.
  const pressedFrom = useRef<HTMLElement | null>(null)

  // Unmounted while holding focus (the attention list emptied): hand focus back.
  useLayoutEffect(() => {
    const el = root.current
    return () => {
      if (el?.contains(document.activeElement) && previous.current?.isConnected)
        previous.current.focus()
    }
  }, [])

  useEffect(() => {
    if (!open) return
    if (open.keyboard) items(list.current)[0]?.focus()
    else list.current?.focus()
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

  const show = (keyboard: boolean) => {
    previous.current = keyboard ? null : pressedFrom.current
    pressedFrom.current = null
    setOpen({ keyboard })
  }

  const closeAndRestore = () => {
    setOpen(false)
    const back = previous.current?.isConnected ? previous.current : trigger.current
    back?.focus()
  }

  // Keys are handled only while focus is in the menu, so they're never taken from anything else.
  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' && e.target === trigger.current) {
        e.preventDefault()
        show(true)
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeAndRestore()
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
        if (e.relatedTarget && !root.current?.contains(e.relatedTarget)) setOpen(false)
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
            active instanceof HTMLElement &&
            active !== document.body &&
            !root.current?.contains(active)
              ? active
              : null
        }}
        // `detail` is 0 when the click came from Enter or Space.
        onClick={(e) => (open ? closeAndRestore() : show(e.detail === 0))}
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
          <CloseMenu.Provider value={closeAndRestore}>{children}</CloseMenu.Provider>
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
        // Close (restoring focus) first, so an item that moves focus itself has the last word.
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
