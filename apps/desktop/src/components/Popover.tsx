import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

import { createPortal } from 'react-dom'

import { CloseMenu, MenuOpens } from './menuContext'

export type PopoverProps = {
  label: ReactNode
  title?: string
  align?: 'left' | 'right'
  className?: string
  triggerClassName?: string
  listClassName?: string
  caret?: boolean
  keepMounted?: boolean
  /** Render outside scrollable panels, positioning the list beside its trigger. */
  portal?: boolean
  children: ReactNode
}

/**
 * A trigger button and a popup. While open the popup holds focus, so keys never reach a terminal
 * underneath. Escape, the trigger or the window losing focus closes it and hands focus back to
 * whatever had it before (the trigger, when opened from the keyboard); a press elsewhere or focus
 * moving away just closes it. With `keepMounted` the popup stays rendered (hidden) while closed,
 * so content that loads state is ready when it opens. `Menu` adds list keyboard handling on top.
 */
export default function Popover({
  label,
  title,
  align = 'left',
  className = '',
  triggerClassName = '',
  listClassName = '',
  caret = true,
  keepMounted = false,
  portal = false,
  role = 'dialog',
  initialFocus,
  onOpenKeyDown,
  children,
}: PopoverProps & {
  role?: 'menu' | 'dialog'
  /** What takes focus on open, instead of the popup itself. */
  initialFocus?: (list: HTMLElement, keyboard: boolean) => HTMLElement | undefined
  /** Keys pressed while open, other than Escape. */
  onOpenKeyDown?: (
    e: KeyboardEvent<HTMLDivElement>,
    popover: { close: (restore: boolean) => void; list: HTMLElement | null },
  ) => void
}) {
  // `keyboard`: opened with Enter/Space/ArrowDown.
  const [open, setOpen] = useState<false | { keyboard: boolean }>(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // Where focus was when the popup opened. The trigger never takes focus on a mouse press, so
  // this is read once at open time.
  const previous = useRef<HTMLElement | null>(null)
  const [opens, setOpens] = useState(0)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const contains = (active: Node | null) =>
    !!active && (!!root.current?.contains(active) || !!list.current?.contains(active))

  // Follows the trigger every frame while open, since any reflow (not only a scroll or resize)
  // can move it; `setPosition` skips unchanged positions, so a still layout doesn't re-render.
  useLayoutEffect(() => {
    if (!open || !portal) return
    let frame = 0
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      const popup = list.current?.getBoundingClientRect()
      if (anchor && popup) {
        const left = Math.max(
          8,
          Math.min(
            align === 'right' ? anchor.right - popup.width : anchor.left,
            window.innerWidth - popup.width - 8,
          ),
        )
        const top = Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - popup.height - 8))
        setPosition((old) => (old.left === left && old.top === top ? old : { left, top }))
      }
      frame = requestAnimationFrame(place)
    }
    place()
    return () => cancelAnimationFrame(frame)
  }, [open, portal, align])

  const openPopup = (keyboard: boolean) => {
    const active = document.activeElement
    previous.current = keyboard
      ? trigger.current
      : active instanceof HTMLElement && active !== document.body && !active.closest('.menu-list')
        ? active
        : null
    setOpen({ keyboard })
    setOpens((n) => n + 1)
  }

  /** Close, handing focus back if it is still inside the popup (or nowhere). */
  const close = (restore: boolean) => {
    const active = document.activeElement
    if (!active || active === document.body || contains(active)) {
      const back = restore && previous.current?.isConnected ? previous.current : null
      if (back) back.focus()
      else if (active instanceof HTMLElement && contains(active)) active.blur()
    }
    previous.current = null
    setOpen(false)
  }
  const latest = useRef({ close, initialFocus })
  useEffect(() => {
    latest.current = { close, initialFocus }
  })

  useEffect(() => {
    if (!open) return
    const listEl = list.current
    if (listEl) (latest.current.initialFocus?.(listEl, open.keyboard) ?? listEl).focus()
    // A press outside closes the popup without swallowing it, so the next control still gets it;
    // presses in frames or other windows blur this one. Pressing another popup's trigger hands
    // focus back first, so that one can return it to the same place.
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element
      if (contains(target)) return
      latest.current.close(!!target.closest?.('.menu-trigger'))
    }
    const onBlur = () => latest.current.close(true)
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  // If the focused element went away (an attention item resolved), focus fell to <body>; take it
  // back so the popup keeps hearing keys.
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

  const popup = (
    <div
      ref={list}
      className={`menu-list ${align} ${listClassName}`}
      role={role}
      aria-label={title}
      style={
        portal
          ? { position: 'fixed', left: position.left, top: position.top, right: 'auto' }
          : undefined
      }
      tabIndex={-1}
      hidden={!open}
    >
      <MenuOpens.Provider value={opens}>
        <CloseMenu.Provider value={() => close(true)}>{children}</CloseMenu.Provider>
      </MenuOpens.Provider>
    </div>
  )

  return (
    <div
      className={`menu ${className}`}
      ref={root}
      onKeyDown={(e) => {
        if (!open) {
          if (e.key === 'ArrowDown' && e.target === trigger.current) {
            e.preventDefault()
            openPopup(true)
          }
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          close(true)
          return
        }
        onOpenKeyDown?.(e, { close, list: list.current })
      }}
      onBlur={(e) => {
        // Focus moved to another control (the command palette opening, say).
        if (open && e.relatedTarget && !contains(e.relatedTarget)) close(false)
      }}
    >
      <button
        ref={trigger}
        className={`menu-trigger ${triggerClassName}`}
        aria-haspopup={role}
        aria-expanded={!!open}
        title={title}
        // Keep focus where it is (a terminal, say) so it can be handed back on close.
        onMouseDown={(e) => e.preventDefault()}
        // `detail` is 0 when the click came from Enter or Space.
        onClick={(e) => (open ? close(true) : openPopup(e.detail === 0))}
      >
        {label}
        {caret && (
          <span className="menu-caret" aria-hidden>
            ▾
          </span>
        )}
      </button>
      {(open || keepMounted) && (portal ? createPortal(popup, document.body) : popup)}
    </div>
  )
}
