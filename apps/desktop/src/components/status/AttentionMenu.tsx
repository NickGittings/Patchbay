import { attentionItems, revealTerminal } from '../../lib/attention'
import { useClockTick } from '../../lib/clock'
import { focusTerminal } from '../../lib/terminals'
import { useStore } from '../../store'
import PanelContent from '../PanelContent'

/** Toolbar summary of the terminals that want the user, most urgent first. */
export default function AttentionMenu() {
  const nodes = useStore((s) => s.nodes)
  const sessions = useStore((s) => s.sessions)
  useClockTick()
  const runtimeTerminals = useStore((s) => s.runtimeTerminals)
  const devices = useStore((s) => s.devices)
  const tasks = useStore((s) => s.tasks)
  const sessionRecords = useStore((s) => s.sessionRecords)
  const rootTerminals = useStore((s) => s.rootTerminals)
  const taskWorkspaces = useStore((s) => s.taskWorkspaces)
  const auto = useStore((s) => s.auto)
  const activeTask = useStore((s) => s.activeTask)
  const items = attentionItems({
    nodes,
    sessions,
    runtimeTerminals,
    devices,
    tasks,
    sessionRecords,
    rootTerminals,
    taskWorkspaces,
    activeTask,
    auto,
  })

  if (items.length === 0) return null
  return (
    <PanelContent>
      <div className="panel-section-head">
        <h3 className="section-title">Needs attention</h3>
        <span className="count">{items.length}</span>
      </div>
      {items.map((item) => (
        <button
          key={item.sid}
          className={`attention-item health-${item.status.health}`}
          onClick={() => {
            revealTerminal(item)
            // So typing answers the revealed terminal, once the view switch has attached it.
            if (!item.auto) focusTerminal(item.sid)
          }}
        >
          <span className="status-dot" />
          <span className="attention-what">
            <span>
              <strong>{item.owner}</strong>: {item.terminal.name}
              {item.taskTitle && <em className="attention-task"> ({item.taskTitle})</em>}
            </span>
            {item.status.detail && <small>{item.status.detail}</small>}
          </span>
          <span className="attention-label">{item.status.label}</span>
        </button>
      ))}
    </PanelContent>
  )
}
