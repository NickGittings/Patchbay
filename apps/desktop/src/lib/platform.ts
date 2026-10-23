import type { MouseEvent } from 'react'

export const isMac = /mac/i.test(navigator.userAgent)

export const modifierKey = isMac ? '⌘' : 'Ctrl'
export const shiftKey = isMac ? '⇧' : 'Shift'
export const mod = isMac ? '⌘' : 'Ctrl+'
export const shiftMod = isMac ? '⇧⌘' : 'Ctrl+Shift+'

/** Tauri's drag region zooms on mouseup on macOS but leaves the double-click's mousedown alone, so
 * WebKit would select text beside the bar: the search box's. */
export const titleBarMouseDown = (e: MouseEvent) => {
  if (e.target === e.currentTarget && e.detail > 1) e.preventDefault()
}
