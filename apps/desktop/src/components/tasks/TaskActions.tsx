import { useMainWorktree } from '../../lib/mainWorktree'
import { seedNewTask } from '../../lib/tasks'
import { useStore } from '../../store'
import AddTaskTerminal from './AddTaskTerminal'

/** Build's header actions; the toolbar's worktree picker chooses the worktree. */
export default function TaskActions() {
  const projectId = useStore((s) => s.project?.id)
  // Read by the toolbar's worktree picker, which is shown whenever a project is.
  const git = useMainWorktree((m) => !!m[projectId ?? '']?.git)
  return (
    <div className="task-tab-actions">
      <AddTaskTerminal />
      <button
        className="header-action"
        disabled={!git}
        title={git ? 'Create a task workspace' : 'Named tasks require a Git repository'}
        onClick={() => seedNewTask()}
      >
        ＋ New task
      </button>
    </div>
  )
}
