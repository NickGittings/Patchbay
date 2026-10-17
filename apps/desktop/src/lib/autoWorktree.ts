import { useStore } from '../store'
import { autoDraftKey, autoDrafts, emptyAutoDraft } from './autoDrafts'
import { seedNewTask, titleFor } from './tasks'

/**
 * Auto's "New worktree…" for the project folder: a new worktree starts with a copy of the project
 * plan, and the goal the user typed (else the copied plan fills it in there) moves with the
 * dialog's other choices to that worktree's draft. A goal the dialog only `inferred` titles the
 * worktree but isn't kept as typed. An existing worktree picked instead that has a draft of its own
 * keeps it, and the project folder then keeps its draft too, so nothing typed is lost.
 */
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
    { title: titleFor(goal) || undefined, copyPlan: true },
  )
}
