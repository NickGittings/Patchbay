import { attentionCounts } from '../../lib/attention'
import { useStore } from '../../store'

/**
 * Toolbar switcher between the open worktree and the tasks' worktrees. Switching only changes
 * which worktree the map, terminals, changes and review follow; nothing is stopped.
 */
export default function TaskMenu() {
  const tasks = useStore((s) => s.tasks)
  const activeTask = useStore((s) => s.activeTask)
  const setActiveTask = useStore((s) => s.setActiveTask)
  // Count terminals that want the user per task, so other tasks' needs stay visible.
  const waiting = useStore(attentionCounts)
  const counts = JSON.parse(waiting) as Record<string, number>
  const mark = (key: string) => (counts[key] ? ` ● ${counts[key]}` : '')
  const openNew = () => {
    const s = useStore.getState()
    s.setNewTask(s.highlighted.length ? [...s.highlighted] : s.selectedId ? [s.selectedId] : [])
  }

  return (
    <div className="task-menu" role="group" aria-label="Task">
      <select
        className={`task-select ${activeTask ? 'in-task' : ''}`}
        title="Which worktree terminals, changes and review follow"
        value={activeTask ?? ''}
        onChange={(e) => setActiveTask(e.target.value || null)}
      >
        <option value="">Open worktree{mark('')}</option>
        {tasks.map((t) => (
          <option key={t.id} value={t.id} disabled={t.missing}>
            {t.title}
            {t.branch ? ` (${t.branch})` : ''}
            {t.missing ? ' — missing' : ''}
            {mark(t.id)}
          </option>
        ))}
      </select>
      <button title="Start a task on a new branch and worktree" onClick={openNew}>
        + Task
      </button>
    </div>
  )
}
