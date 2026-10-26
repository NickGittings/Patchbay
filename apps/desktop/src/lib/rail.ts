import { create } from 'zustand'
import { useStore, type UtilityPanel } from '../store'
import type { View } from '../types'

export type { UtilityPanel }
export const railViews: { id: View; label: string }[] = [
  { id: 'navigation', label: 'Navigation' },
  { id: 'plan', label: 'Plan' },
  { id: 'implementation', label: 'Build' },
  { id: 'review', label: 'Review' },
]
export const useRail = create<{ settings: string | null }>(() => ({ settings: null }))
/** The open utility panel lives in the store alone (`utilityPanel`). */
export function selectPanel(panel: UtilityPanel | null) {
  useStore.setState({ utilityPanel: panel })
}
export function togglePanel(panel: UtilityPanel) {
  selectPanel(useStore.getState().utilityPanel === panel ? null : panel)
}
/** Closes `panel` if it is the open one, leaving any other open. */
export function closePanel(panel: UtilityPanel) {
  if (useStore.getState().utilityPanel === panel) selectPanel(null)
}
// Agent roles belong to one project; another store's listener, so nothing re-enters `useStore`.
useStore.subscribe((s, previous) => {
  if (
    previous.project &&
    previous.project.id !== s.project?.id &&
    useRail.getState().settings === 'roles'
  )
    useRail.setState({ settings: null })
})
/** Rail clicks and numbered shortcuts open the selected Full view. */
export function selectRailShortcut(view: View) {
  selectRailView(view)
}
export function selectRailView(view: View) {
  const s = useStore.getState()
  if (!s.project) return
  if (s.simpleMode) s.setSimpleMode(false)
  s.setView(view)
}
export function selectedRailView(): View | null {
  const s = useStore.getState()
  return s.simpleMode ? 'navigation' : s.view
}
export function panelWidth(width: number, windowWidth: number) {
  return Math.max(240, Math.min(Number.isFinite(width) ? width : 360, 640, windowWidth - 460))
}
