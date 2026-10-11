import { useEffect, useRef, useState } from 'react'
import { attentionCounts } from '../../lib/attention'
import { gitWorktrees } from '../../lib/ipc'
import { seedNewTask } from '../../lib/tasks'
import { useStore } from '../../store'
import Popover from '../Popover'
import AddTaskTerminal from './AddTaskTerminal'
import { WorktreeOverview } from './WorktreePicker'

export default function TaskTabs() {
  const projectId = useStore((s) => s.project?.id)
  const tasks = useStore((s) => s.tasks)
  const closedTaskIds = useStore((s) => s.closedTaskIds)
  const activities = useStore((s) => s.taskActivities)
  const seen = useStore((s) => s.seenActivities)
  const active = useStore((s) => s.activeTask)
  const counts = JSON.parse(useStore(attentionCounts)) as Record<string, number>
  const [git, setGit] = useState(false)
  const tabList = useRef<HTMLDivElement>(null)
  const restoreTabFocus = useRef(false)
  useEffect(() => {
    if (!restoreTabFocus.current) return
    restoreTabFocus.current = false
    // Wait for the newly selected workspace's terminal panes to finish attaching and focusing.
    const timer = setTimeout(() =>
      tabList.current
        ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
        ?.focus(),
    )
    return () => clearTimeout(timer)
  }, [closedTaskIds])
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
    ...(active !== null && tasks.some((t) => t.current && !t.missing)
      ? []
      : [{ id: null, title: 'Main worktree', missing: false, worktree: '', current: true }]),
    ...tasks.filter((task) => task.current || !closedTaskIds.includes(task.id)),
  ]
  return (
    <div className="task-tabs">
      <div ref={tabList} className="task-tab-list" role="tablist" aria-label="Task workspaces">
        {tabs.map((task) => (
          <div
            key={task.id ?? ''}
            role="presentation"
            className={`task-tab ${active === task.id ? 'active' : ''}`}
          >
            <button
              role="tab"
              aria-selected={active === task.id}
              className={`tab ${active === task.id ? 'active' : ''}`}
              disabled={task.missing}
              title={task.missing ? `${task.title}: worktree unavailable` : task.worktree}
              onClick={() => {
                const s = useStore.getState()
                s.setActiveTask(task.id, true)
                useStore.setState({
                  seenActivities: [
                    ...new Set([
                      ...s.seenActivities,
                      ...Object.values(activities)
                        .filter(
                          (a) =>
                            a.projectId === projectId &&
                            a.task === task.id &&
                            a.state !== 'running',
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
            {task.id !== null && !task.current && (
              <button
                className="task-tab-close"
                aria-label={`Close ${task.title} tab`}
                title="Close tab; task and terminals stay available in the task menu"
                onClick={(e) => {
                  restoreTabFocus.current = document.activeElement === e.currentTarget
                  useStore.getState().closeTaskTab(task.id)
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <Popover
          label="⋯"
          title="Task menu"
          caret={false}
          className="task-menu"
          listClassName="worktree-popover"
          portal
        >
          <WorktreeOverview attention={counts} />
        </Popover>
      </div>
      <div className="task-tab-actions">
        <AddTaskTerminal />
        <button
          className="header-action"
          disabled={!git}
          title={git ? 'Create a task workspace' : 'Named tasks require a Git repository'}
          onClick={seedNewTask}
        >
          ＋ New task
        </button>
      </div>
    </div>
  )
}
