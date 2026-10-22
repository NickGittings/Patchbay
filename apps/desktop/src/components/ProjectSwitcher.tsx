import { useStore } from '../store'
import { closeProjectTab, useOpenProject } from '../lib/project'
import Menu, { MenuItem, MenuRow, MenuSeparator, MenuSideButton } from './Menu'

/** Which project is open, and a menu to switch, close or open another one. */
export default function ProjectSwitcher() {
  const order = useStore((s) => s.projectOrder)
  const projects = useStore((s) => s.projects)
  const activeId = useStore((s) => s.activeProjectId)
  const records = useStore((s) => s.sessionRecords)
  const activate = useStore((s) => s.activateProject)
  const openFolder = useOpenProject()
  if (!order.length) return null
  const running = (id: string) =>
    records.filter((r) => r.metadata.projectId === id && r.snapshot?.running).length
  const status = (id: string) => {
    const count = running(id)
    return (
      <>
        {projects[id]?.unavailable && <span className="project-status"> (unavailable)</span>}
        {!!count && <span className="project-status"> ({count} running)</span>}
      </>
    )
  }
  // An unavailable sole project may have no active identity yet; name the first one then.
  const shown = projects[activeId ?? ''] ? activeId! : order.find((id) => projects[id])
  const active = shown ? projects[shown] : undefined
  if (!active || !shown) return null
  return (
    <Menu
      className="project-switcher"
      caret={false}
      label={
        <>
          <span className="project-name">{active.name}</span>
          {status(shown)}
        </>
      }
      title={`${active.root}\nSwitch, close or open projects`}
      triggerLabel={`Project: ${active.name}`}
    >
      {order.map((id) => {
        const entry = projects[id]
        if (!entry) return null
        return (
          <MenuRow key={id}>
            <MenuItem
              className="menu-item project-switcher-item"
              checked={activeId === id}
              radio
              title={`${entry.root}\nDelete closes this project`}
              aria-keyshortcuts="Delete"
              onClick={() => activate(id)}
              onKeyDown={(e) => {
                // The close × stays out of the arrow-key ring; Delete reaches it from the keyboard.
                if (e.key !== 'Delete' && e.key !== 'Backspace') return
                e.preventDefault()
                // A key is easy to press by accident; ask first while terminals are running.
                const count = running(id)
                if (
                  count &&
                  !window.confirm(
                    `Close ${entry.name}? It has ${count} running terminal${count === 1 ? '' : 's'}.`,
                  )
                )
                  return
                e.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>('.project-switcher-close')
                  ?.click()
              }}
            >
              <span className="project-switcher-name">
                <span className="project-name">{entry.name}</span>
                {status(id)}
              </span>
            </MenuItem>
            <MenuSideButton
              className="menu-item menu-side project-switcher-close"
              aria-label={`Close ${entry.name}`}
              title={`Close ${entry.name}`}
              onClick={() => void closeProjectTab(id)}
            >
              ×
            </MenuSideButton>
          </MenuRow>
        )
      })}
      <MenuSeparator />
      <MenuItem onClick={() => void openFolder()}>Open folder…</MenuItem>
    </Menu>
  )
}
