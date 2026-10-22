import { create } from 'zustand'
import { useStore } from '../store'
import { simpleKey, useSimpleUi } from './simpleUi'
import type { View } from '../types'

export type UtilityPanel = 'project' | 'worktree' | 'auto' | 'activity' | 'sessions'
export const railViews: { id: View; label: string }[] = [
  { id: 'navigation', label: 'Navigation' },
  { id: 'plan', label: 'Plan' },
  { id: 'implementation', label: 'Build' },
  { id: 'review', label: 'Review' },
]
export const useRail = create<{ panel: UtilityPanel | null; settings: string | null }>(() => ({
  panel: null,
  settings: null,
}))
export function selectPanel(panel: UtilityPanel | null) {
  useRail.setState({ panel })
  useStore.setState({
    sessionsPanelOpen: panel === 'sessions',
    activityPanelOpen: panel === 'activity',
  })
}
export function togglePanel(panel: UtilityPanel) {
  selectPanel(useRail.getState().panel === panel ? null : panel)
}
// Keep existing programmatic requests (including extensions and terminal attention) working.
useStore.subscribe((s, previous) => {
  if (s.sessionsPanelOpen !== previous.sessionsPanelOpen) {
    if (s.sessionsPanelOpen) selectPanel('sessions')
    else if (useRail.getState().panel === 'sessions') selectPanel(null)
  }
  if (s.activityPanelOpen !== previous.activityPanelOpen) {
    if (s.activityPanelOpen) selectPanel('activity')
    else if (useRail.getState().panel === 'activity') selectPanel(null)
  }
  if (s.autoPanelRequest !== previous.autoPanelRequest) selectPanel('auto')
})
export function selectRailView(view: View) {
  const s = useStore.getState()
  if (!s.project) return
  if (!s.simpleMode) s.setView(view)
  else
    useSimpleUi.getState().patch(simpleKey(s.project.id, s.activeTask), {
      stageFilter: view === 'navigation' ? 'all' : view === 'implementation' ? 'build' : view,
    })
}
export function selectedRailView(): View {
  const s = useStore.getState()
  if (!s.simpleMode) return s.view
  const filter =
    useSimpleUi.getState().worktrees[simpleKey(s.project?.id, s.activeTask)]?.stageFilter
  return !filter || filter === 'all'
    ? 'navigation'
    : filter === 'build'
      ? 'implementation'
      : filter === 'merge'
        ? 'review'
        : filter
}
export function panelWidth(width: number, windowWidth: number) {
  return Math.max(240, Math.min(Number.isFinite(width) ? width : 360, 640, windowWidth - 460))
}
