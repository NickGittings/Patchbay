import { useEffect, useState } from 'react'
import { attentionCounts } from '../../lib/attention'
import { gitWorktrees } from '../../lib/ipc'
import { seedNewTask } from '../../lib/tasks'
import { useStore } from '../../store'

export default function TaskTabs() {
  const projectId = useStore((s) => s.project?.id)
  const tasks = useStore((s) => s.tasks)
  const activities = useStore((s) => s.taskActivities)
  const seen = useStore((s) => s.seenActivities)
  const active = useStore((s) => s.activeTask)
  const counts = JSON.parse(useStore(attentionCounts)) as Record<string, number>
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
  for (const activity of Object.values(activities)) {
    if (
      activity.projectId === projectId &&
      activity.state !== 'running' &&
      !seen.includes(activity.id)
    )
      counts[activity.task ?? ''] = (counts[activity.task ?? ''] ?? 0) + 1
  }
  const tabs = [
    ...(tasks.some((t) => t.current && !t.missing)
      ? []
      : [{ id: null, title: 'Project folder', missing: false, worktree: '' }]),
    ...tasks,
  ]
  return (
    <div className="task-tabs" role="tablist" aria-label="Task workspaces">
      {tabs.map((task) => (
        <button
          key={task.id ?? ''}
          role="tab"
          aria-selected={active === task.id}
          className={`tab ${active === task.id ? 'active' : ''}`}
          disabled={task.missing}
          title={task.missing ? `${task.title}: worktree unavailable` : task.worktree}
          onClick={() => {
            const s = useStore.getState()
            s.setActiveTask(task.id)
            useStore.setState({
              seenActivities: [
                ...new Set([
                  ...s.seenActivities,
                  ...Object.values(activities)
                    .filter(
                      (a) =>
                        a.projectId === projectId && a.task === task.id && a.state !== 'running',
                    )
                    .map((a) => a.id),
                ]),
              ],
            })
          }}
        >
          {task.title}
          {task.missing ? ' · unavailable' : ''}
          {(counts[task.id ?? ''] ?? 0) > 0 && (
            <span className="worktree-attention-dot">● {counts[task.id ?? '']}</span>
          )}
        </button>
      ))}
      <button
        className="header-action"
        disabled={!git}
        title={git ? 'Create a task workspace' : 'Named tasks require a Git repository'}
        onClick={seedNewTask}
      >
        ＋ New task
      </button>
    </div>
  )
}
