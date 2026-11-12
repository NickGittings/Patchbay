import { useContext } from 'react'
import { CloseMenu } from './menuContext'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { closeProjectTab } from '../lib/project'
import { runningInProject } from '../lib/sessionList'
import RunningTag from './RunningTag'

/** Open projects in the footer popover. */
export default function ProjectSwitcher() {
  const close = useContext(CloseMenu)
  const activate = (id: string) => {
    close()
    useStore.getState().activateProject(id)
  }
  const order = useStore((s) => s.projectOrder)
  const projects = useStore((s) => s.projects)
  const activeId = useStore((s) => s.activeProjectId)
  // Counted in the selector, so live session updates re-render only when a count changes.
  const running = useStore(
    useShallow((s) =>
      s.projectOrder.map((id) => runningInProject(s.sessionRecords, s.sessions, id)),
    ),
  )
  return (
    <div className="project-list" aria-label="Open projects">
      {order.map((id, i) => {
        const entry = projects[id]
        if (!entry) return null
        const needsAttention =
          entry.conflict || ['error', 'conflict'].includes(entry.mapSave?.status ?? '')
        return (
          <div
            className={`panel-list-row ${activeId === id ? 'active' : ''}`}
            key={id}
            onClick={(e) => {
              if ((e.target as Element).closest('button, a, input, textarea, select')) return
              if (window.getSelection()?.toString()) return
              activate(id)
            }}
          >
            <button
              className="grow"
              aria-pressed={activeId === id}
              title={entry.root}
              onClick={() => activate(id)}
            >
              <span className="project-name">{entry.name}</span>
              {entry.unavailable && <span className="worktree-tag bad">unavailable</span>}
            </button>
            <button
              className="panel-row-actions"
              aria-label={`Close ${entry.name}`}
              onClick={() => void closeProjectTab(id)}
            >
              ×
            </button>
            {(needsAttention || running[i] > 0) && (
              <div className="project-status">
                {needsAttention && (
                  <span
                    className="worktree-tag bad"
                    title={entry.mapSave?.error ?? 'Map needs attention'}
                  >
                    Needs attention
                  </span>
                )}
                <RunningTag count={running[i]} />
              </div>
            )}
          </div>
        )
      })}
      {!order.length && <p>No open projects.</p>}
    </div>
  )
}
