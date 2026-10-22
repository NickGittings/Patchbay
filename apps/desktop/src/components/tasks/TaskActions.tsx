import { useEffect, useState } from 'react'
import { gitWorktrees } from '../../lib/ipc'
import { seedNewTask } from '../../lib/tasks'
import { useStore } from '../../store'
import AddTaskTerminal from './AddTaskTerminal'

/** Build's header actions; the toolbar's worktree picker chooses the worktree. */
export default function TaskActions() {
  const projectId = useStore((s) => s.project?.id)
  const [git, setGit] = useState(false)
  useEffect(() => {
    let disposed = false
    void gitWorktrees()
      .then((trees) => {
        if (!disposed) setGit(!!trees.length)
      })
      .catch(() => {
        if (!disposed) setGit(false)
      })
    return () => {
      disposed = true
    }
  }, [projectId])
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
