import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { closeProjectTab } from '../lib/project'
import { runningInProject } from '../lib/sessionList'

/** Open projects in the Project utility panel. */
export default function ProjectSwitcher() {
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
        return (
          <div className="row" key={id}>
            <button
              className="grow"
              aria-pressed={activeId === id}
              title={entry.root}
              onClick={() => useStore.getState().activateProject(id)}
            >
              {entry.name}
              {entry.unavailable ? ' (unavailable)' : ''}
              {running[i] ? ` (${running[i]} running)` : ''}
            </button>
            <button aria-label={`Close ${entry.name}`} onClick={() => void closeProjectTab(id)}>
              ×
            </button>
          </div>
        )
      })}
      {!order.length && <p>No open projects.</p>}
    </div>
  )
}
