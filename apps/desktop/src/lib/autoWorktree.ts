import { useStore } from '../store'
import { autoDraftKey, autoDrafts, emptyAutoDraft } from './autoDrafts'
import { seedNewTask, titleFor } from './tasks'

/** Carry Auto's goal and dialog choices into a new worktree with an independent plan. */
export function seedAutoTask(draftKey: string, goal: string, inferred = false) {
  const carried = inferred ? '' : goal.trim()
  const saved = autoDrafts.get(draftKey)
  seedNewTask(
    (created, projectId) => {
      const target = autoDraftKey(projectId, created.id)
      if (!autoDrafts.has(target)) {
        autoDrafts.delete(draftKey)
        if (saved || carried)
          autoDrafts.set(target, {
            ...(saved ?? emptyAutoDraft()),
            goal: carried || undefined,
            destination: undefined,
            stage: '',
          })
      }
      // Only while the user is still on that worktree; another tab's panel isn't this one's.
      const s = useStore.getState()
      if (s.project?.id === projectId && s.activeTask === created.id) s.showAutoPanel()
    },
    { title: titleFor(goal) || undefined },
  )
}
