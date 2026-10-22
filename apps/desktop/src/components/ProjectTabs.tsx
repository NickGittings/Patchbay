import { useStore } from '../store'
import { closeProjectTab } from '../lib/project'

/** The open projects as tabs in the toolbar, including the sole open project. */
export default function ProjectTabs() {
  const order = useStore((s) => s.projectOrder)
  const projects = useStore((s) => s.projects)
  const activeId = useStore((s) => s.activeProjectId)
  const records = useStore((s) => s.sessionRecords)
  const activate = useStore((s) => s.activateProject)
  if (!order.length) return null
  return (
    <nav className="project-tabs" aria-label="Projects">
      {order.map((id) => {
        const entry = projects[id]
        const count = records.filter(
          (r) => r.metadata.projectId === id && r.snapshot?.running,
        ).length
        return (
          <div className={activeId === id ? 'project-tab active' : 'project-tab'} key={id}>
            <button
              role="tab"
              aria-selected={activeId === id}
              onClick={() => activate(id)}
              title={entry.root}
            >
              {entry.name}
              {entry.unavailable ? ' (unavailable)' : ''}
              {count ? ` (${count} running)` : ''}
            </button>
            <button aria-label={`Close ${entry.name}`} onClick={() => void closeProjectTab(id)}>
              ×
            </button>
          </div>
        )
      })}
    </nav>
  )
}
