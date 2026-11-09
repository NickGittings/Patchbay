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

export function usePlanningTask() {
  const task = useStore((s) => s.activeTask)
  const fullPlan = useStore((s) => !s.simpleMode && s.view === 'plan')
  const key = useStore((s) => JSON.stringify([s.project?.id, s.activeTask]))
  const draftKey = usePlanningSelection((s) => s.draftKey)
  useEffect(() => {
    if (
      usePlanningSelection.getState().draftKey &&
      usePlanningSelection.getState().draftKey !== key
    )
      usePlanningSelection.getState().selectDraft(false)
  }, [key])
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
