import { useStore } from '../store'
import { closeProjectTab } from '../lib/project'

/** Open projects in the Project utility panel. */
export default function ProjectSwitcher() {
  const order = useStore((s) => s.projectOrder)
  const projects = useStore((s) => s.projects)
  const activeId = useStore((s) => s.activeProjectId)
  const records = useStore((s) => s.sessionRecords)
  return (
    <div className="project-list" aria-label="Open projects">
      {order.map((id) => {
        const entry = projects[id]
        if (!entry) return null
        const running = records.filter(
          (r) => r.metadata.projectId === id && r.snapshot?.running,
        ).length
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
              {running ? ` (${running} running)` : ''}
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
