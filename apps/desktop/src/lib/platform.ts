export const isMac = /mac/i.test(navigator.userAgent)

export const modifierKey = isMac ? '⌘' : 'Ctrl'
export const shiftKey = isMac ? '⇧' : 'Shift'
export const mod = isMac ? '⌘' : 'Ctrl+'
export const shiftMod = isMac ? '⇧⌘' : 'Ctrl+Shift+'
