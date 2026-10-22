import { useEffect } from 'react'
import { ensureMainWorktree, useMainWorktree } from '../../lib/mainWorktree'
import { seedNewTask } from '../../lib/tasks'
import { useStore } from '../../store'
import AddTaskTerminal from './AddTaskTerminal'

/** Build's header actions; the toolbar's worktree picker chooses the worktree. */
export default function TaskActions() {
  const projectId = useStore((s) => s.project?.id)
  const git = useMainWorktree((m) => !!m[projectId ?? '']?.git)
  // Usually read already by the toolbar's worktree picker.
  useEffect(() => ensureMainWorktree(projectId), [projectId])
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
