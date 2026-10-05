import { createContext } from 'react'

/** Closes the enclosing `Menu`, handing focus back. */
export const CloseMenu = createContext<() => void>(() => {})

/** How many times the enclosing `Menu` has opened, for items that refresh what they show. */
export const MenuOpens = createContext(0)
