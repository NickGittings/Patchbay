import { createContext } from 'react'

/** Closes the enclosing `Menu`, handing focus back. */
export const CloseMenu = createContext<() => void>(() => {})

/** Whether the enclosing `Menu` is open, for items that refresh what they show on open. */
export const MenuOpen = createContext(false)
