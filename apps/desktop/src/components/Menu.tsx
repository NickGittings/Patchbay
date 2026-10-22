import { useContext, type ButtonHTMLAttributes, type ReactNode } from 'react'

import { CloseMenu } from './menuContext'
import Popover, { type PopoverProps } from './Popover'

/**
 * Enabled items only: focus can't land on a disabled one, so arrows would stop there. Side buttons
 * (`MenuSideButton`) stay out of the ring.
 */
const items = (list: HTMLElement | null) =>
  Array.from(
    list?.querySelectorAll<HTMLButtonElement>(
      ':is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"])' +
        ':not(:disabled, [data-menu-side])',
    ) ?? [],
  )

/** Focus the next item in `step`'s direction, wrapping; from outside, down starts first, up last. */
const move = (all: HTMLButtonElement[], step: 1 | -1) => {
  if (!all.length) return
  const at = all.indexOf(document.activeElement as HTMLButtonElement)
  const next = at < 0 ? (step > 0 ? 0 : all.length - 1) : (at + step + all.length) % all.length
  all[next].focus()
}

/**
 * A toolbar dropdown: a `Popover` holding a list of `MenuItem`s. Opened from the keyboard, the
 * first item takes focus; arrow keys move between items, choosing one closes the menu, and Tab
 * leaves it.
 */
export default function Menu(props: PopoverProps) {
  return (
    <Popover
      {...props}
      role="menu"
      initialFocus={(list, keyboard) => (keyboard ? items(list)[0] : undefined)}
      onOpenKeyDown={(e, { close, list }) => {
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
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        e.preventDefault()
        e.stopPropagation()
        move(items(list), e.key === 'ArrowDown' ? 1 : -1)
      }}
    />
  )
}

/**
 * A menu entry; `className` replaces the default `menu-item` look for custom rows. With `checked`
 * it is a checkbox item that shows a check mark while on, or with `radio` too, one choice of
 * several (the current one checked).
 */
export function MenuItem({
  onClick,
  shortcut,
  checked,
  radio = false,
  className = 'menu-item',
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'role' | 'aria-checked'> & {
  onClick: () => void
  shortcut?: string
  checked?: boolean
  radio?: boolean
  children: ReactNode
}) {
  const close = useContext(CloseMenu)
  return (
    <button
      {...rest}
      role={checked === undefined ? 'menuitem' : radio ? 'menuitemradio' : 'menuitemcheckbox'}
      aria-checked={checked}
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
      {checked !== undefined && <span className="menu-check">{checked ? '✓' : ''}</span>}
      {shortcut && <kbd className="menu-shortcut">{shortcut}</kbd>}
    </button>
  )
}

/**
 * A secondary item beside a `MenuItem` (a row's close ×): clickable, closes the menu like an item,
 * but left out of the arrow-key ring so moving through items never lands on it. Put the pair in a
 * `MenuRow`, so the menu still owns both items.
 */
export function MenuSideButton({
  onClick,
  className = 'menu-item menu-side',
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'role' | 'tabIndex'> & {
  onClick: () => void
}) {
  const close = useContext(CloseMenu)
  return (
    <button
      {...rest}
      className={className}
      type="button"
      role="menuitem"
      data-menu-side=""
      tabIndex={-1}
      onClick={() => {
        close()
        onClick()
      }}
    />
  )
}

/** A row holding a `MenuItem` and its `MenuSideButton`s, presentational to assistive tech. */
export function MenuRow({ children }: { children: ReactNode }) {
  return (
    <div className="menu-row" role="none">
      {children}
    </div>
  )
}

export function MenuSeparator() {
  return <div className="menu-separator" role="separator" />
}
