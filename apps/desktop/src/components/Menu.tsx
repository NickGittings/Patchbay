import {
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'

import { CloseMenu, MenuOpens } from './menuContext'

const items = (list: HTMLElement | null) =>
  Array.from(list?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])

/** Focus the next item in `step`'s direction, wrapping; from outside, down starts first, up last. */
const move = (all: HTMLButtonElement[], step: 1 | -1) => {
  if (!all.length) return
  const at = all.indexOf(document.activeElement as HTMLButtonElement)
  const next = at < 0 ? (step > 0 ? 0 : all.length - 1) : (at + step + all.length) % all.length
  all[next].focus()
}

/**
 * A toolbar dropdown: a trigger button and a list of `MenuItem`s. While open the list holds focus,
 * so keys never reach a terminal underneath. Choosing an item, Escape, the trigger or the window
 * losing focus closes it and hands focus back to whatever had it before (the trigger, when opened
 * from the keyboard); a press elsewhere or focus moving away just closes it. With `keepMounted`
 * the list stays rendered (hidden) while closed, so items that load state, like extension `when`
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
  // `keyboard`: opened with Enter/Space/ArrowDown, so the first item takes focus.
  const [open, setOpen] = useState<false | { keyboard: boolean }>(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // Where focus was when the menu opened. The trigger never takes focus on a mouse press, so
  // this is read once at open time.
  const previous = useRef<HTMLElement | null>(null)
  const [opens, setOpens] = useState(0)

  const openMenu = (keyboard: boolean) => {
    const active = document.activeElement
    previous.current = keyboard
      ? trigger.current
      : active instanceof HTMLElement && active !== document.body && !active.closest('.menu-list')
        ? active
        : null
    setOpen({ keyboard })
    setOpens((n) => n + 1)
  }

  /** Close, handing focus back if it is still inside the menu (or nowhere). */
  const close = (restore: boolean) => {
    const active = document.activeElement
    if (!active || active === document.body || root.current?.contains(active)) {
      const back = restore && previous.current?.isConnected ? previous.current : null
      if (back) back.focus()
      else if (active instanceof HTMLElement && root.current?.contains(active)) active.blur()
    }
    previous.current = null
    setOpen(false)
  }
  const closeRef = useRef(close)
  useEffect(() => {
    closeRef.current = close
  })

  useEffect(() => {
    if (!open) return
    const listEl = list.current
    if (open.keyboard) items(listEl)[0]?.focus()
    else listEl?.focus()
    // A press outside closes the menu without swallowing it, so the next control still gets it;
    // presses in frames or other windows blur this one. Pressing another menu's trigger hands
    // focus back first, so that menu can return it to the same place.
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element
      if (root.current?.contains(target)) return
      closeRef.current(!!target.closest?.('.menu-trigger'))
    }
    const onBlur = () => closeRef.current(true)
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  // If the focused item went away (an attention item resolved), focus fell to <body>; take it
  // back so the menu keeps hearing keys.
  useEffect(() => {
    if (open && document.activeElement === document.body) list.current?.focus()
  })

  // Unmounted while open and focused (the attention list emptied): focus has fallen to <body>,
  // so hand it back to where it was.
  useEffect(() => {
    const saved = previous
    return () => {
      const back = saved.current
      if (back?.isConnected && document.activeElement === document.body) back.focus()
    }
  }, [])

  return (
    <div
      className={`menu ${className}`}
      ref={root}
      onKeyDown={(e) => {
        if (!open) {
          if (e.key === 'ArrowDown' && e.target === trigger.current) {
            e.preventDefault()
            openMenu(true)
          }
          return
        }
        // A held Enter/Space that opened the menu must not also choose its first item.
        if (e.repeat && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          return
        }
        // Tab leaves the menu: hand focus back, then let Tab move on from there.
        if (e.key === 'Tab') {
          close(true)
          return
        }
        if (e.key !== 'Escape' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Escape') close(true)
        else move(items(list.current), e.key === 'ArrowDown' ? 1 : -1)
      }}
      onBlur={(e) => {
        // Focus moved to another control (the command palette opening, say).
        if (open && e.relatedTarget && !root.current?.contains(e.relatedTarget)) close(false)
      }}
    >
      <button
        ref={trigger}
        className={`menu-trigger ${triggerClassName}`}
        aria-haspopup="menu"
        aria-expanded={!!open}
        title={title}
        // Keep focus where it is (a terminal, say) so it can be handed back on close.
        onMouseDown={(e) => e.preventDefault()}
        // `detail` is 0 when the click came from Enter or Space.
        onClick={(e) => (open ? close(true) : openMenu(e.detail === 0))}
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
          <MenuOpens.Provider value={opens}>
            <CloseMenu.Provider value={() => close(true)}>{children}</CloseMenu.Provider>
          </MenuOpens.Provider>
        </div>
      )}
    </div>
  )
}

/** A menu entry; `className` replaces the default `menu-item` look for custom rows. */
export function MenuItem({
  onClick,
  shortcut,
  className = 'menu-item',
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'role'> & {
  onClick: () => void
  shortcut?: string
  children: ReactNode
}) {
  const close = useContext(CloseMenu)
  return (
    <button
      {...rest}
      role="menuitem"
      // Arrow keys move between items; Tab leaves the menu.
      tabIndex={-1}
      className={className}
      onClick={() => {
        // Close (handing focus back) first, so an item that moves focus itself has the last word.
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
