import type { ReactNode } from 'react'
import { CloseMenu } from './menuContext'

/** Existing utility content shares one dock; actions leave it open for further work. */
export default function PanelContent({ children }: { children: ReactNode }) {
  return <CloseMenu.Provider value={() => {}}>{children}</CloseMenu.Provider>
}
