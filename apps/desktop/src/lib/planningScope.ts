import { useEffect } from 'react'
import { create } from 'zustand'
import { useStore, type TaskWorkspace } from '../store'
import { PROJECT_DRAFT } from '../types'

export const usePlanningSelection = create<{
  draftKey: string | null
  selectDraft: (draft: boolean) => void
}>((set) => ({
  draftKey: null,
  selectDraft: (draft) => {
    const s = useStore.getState()
    set({ draftKey: draft ? JSON.stringify([s.project?.id, s.activeTask]) : null })
  },
}))

let stopFollowing: (() => void) | undefined

export function usePlanningTask() {
  // Start once with the application, after the store is available. Leaving Plan or switching
  // checkout resets selection; an explicit draft reveal survives StrictMode's mount replay.
  useEffect(() => {
    stopFollowing ??= useStore.subscribe((s, previous) => {
      if (
        s.project?.id !== previous.project?.id ||
        s.activeTask !== previous.activeTask ||
        (previous.view === 'plan' && s.view !== 'plan') ||
        (!previous.simpleMode && s.simpleMode)
      )
        usePlanningSelection.getState().selectDraft(false)
    })
  }, [])
  const task = useStore((s) => s.activeTask)
  const fullPlan = useStore((s) => !s.simpleMode && s.view === 'plan')
  const key = useStore((s) => JSON.stringify([s.project?.id, s.activeTask]))
  const draftKey = usePlanningSelection((s) => s.draftKey)
  return fullPlan && draftKey === key ? PROJECT_DRAFT : task
}
const EMPTY_HIGHLIGHTS: string[] = []
export const planningHighlights = (
  s: {
    activeTask: string | null
    highlighted: string[]
    taskWorkspaces: Record<string, TaskWorkspace>
  },
  task: string | null,
) =>
  task === s.activeTask
    ? s.highlighted
    : (s.taskWorkspaces[task ?? '']?.highlighted ?? EMPTY_HIGHLIGHTS)

export function togglePlanningHighlight(task: string | null, id: string) {
  const s = useStore.getState()
  if (!s.project) return
  const highlighted = planningHighlights(s, task)
  s.patchTask(s.project.id, task, {
    highlighted: highlighted.includes(id)
      ? highlighted.filter((c) => c !== id)
      : [...highlighted, id],
  })
}
