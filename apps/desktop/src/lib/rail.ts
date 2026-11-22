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
const EXPANDED_KEY = 'patchbay.railExpanded'

export function readRailExpanded() {
  try {
    return localStorage.getItem(EXPANDED_KEY) === 'true'
  } catch {
    return false
  }
}
export function railWidth(expanded: boolean, windowWidth: number) {
  return expanded && windowWidth >= 1100 ? 168 : 52
}
export const useRail = create<{ settings: string | null; expanded: boolean }>(() => ({
  settings: null,
  expanded: readRailExpanded(),
}))
export function setRailExpanded(expanded: boolean) {
  useRail.setState({ expanded })
  try {
    localStorage.setItem(EXPANDED_KEY, String(expanded))
  } catch {
    // Keep the preference for this window when storage is unavailable.
  }
}
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
  return s.simpleMode ? null : s.view
}
export function panelWidth(width: number, windowWidth: number, navigationWidth = 52) {
  return Math.max(
    240,
    Math.min(Number.isFinite(width) ? width : 360, 640, windowWidth - 460 - (navigationWidth - 52)),
  )
}
