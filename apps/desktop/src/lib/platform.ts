const mac = /mac/i.test(navigator.userAgent)

export const modifierKey = mac ? '⌘' : 'Ctrl'
export const shiftKey = mac ? '⇧' : 'Shift'
export const mod = mac ? '⌘' : 'Ctrl+'
export const shiftMod = mac ? '⇧⌘' : 'Ctrl+Shift+'
