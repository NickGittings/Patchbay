import { useStore } from '../store'
import { autoDraftKey, autoDrafts, emptyAutoDraft } from './autoDrafts'
import { seedPlannedTask, titleFor } from './tasks'

/**
 * Auto's "New worktree…" for the project folder: the new worktree takes the project plan as its
 * plan, and the goal the user typed (else the project plan fills it in there) moves with the
 * dialog's other choices to that worktree's draft. An existing worktree picked instead that has a
 * draft of its own keeps it, and the project folder then keeps its draft too, so nothing typed is
 * lost.
 */
export function seedAutoTask(draftKey: string, goal: string) {
  const carried = goal.trim()
  const saved = autoDrafts.get(draftKey)
  seedPlannedTask(
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
    titleFor(carried) || undefined,
  )
}
