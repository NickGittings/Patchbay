import { useState } from 'react'
import { startAgentsIn, startTaskAgent } from '../lib/implement'
import { agentDevices } from '../lib/plan'
import { taskTerminals, visibleTaskTerminals } from '../lib/taskTerminals'
import { useStore } from '../store'
import { TASK_ROOT_SCOPE, parseSessionId } from '../types'
import AddTerminalSelect from './AddTerminalSelect'
import EmptyState from './EmptyState'
import TaskTerminals from './TaskTerminals'
import TaskActivityPanel from './tasks/TaskActivityPanel'
import TaskTabs from './tasks/TaskTabs'
import WorktreePicker from './tasks/WorktreePicker'

export default function ImplementationView() {
  const sessions = useStore((s) => s.sessions)
  const nodes = useStore((s) => s.nodes)
  const projectId = useStore((s) => s.project?.id) ?? ''
  const highlighted = useStore((s) => s.highlighted)
  const rootTerminals = useStore((s) => s.rootTerminals)
  const runtimes = useStore((s) => s.runtimeTerminals)
  const task = useStore((s) => s.activeTask)
  const devices = useStore((s) => s.devices)
  const visible = useStore((s) => s.visibleTerminals)
  const maximized = useStore((s) => s.maximizedTerminal)
  const revealed = useStore((s) => s.revealed)
  const split = useStore((s) => s.panels['task-split']?.orientation ?? 0)
  const [location, setLocation] = useState(TASK_ROOT_SCOPE)
  const agents = agentDevices(devices)
  const entries = taskTerminals(
    { rootTerminals, highlighted },
    nodes,
    runtimes,
    projectId,
    task,
    sessions,
  )
  if (revealed && !entries.some((e) => e.sid === revealed.sid)) {
    const node = nodes.find((n) => n.id === revealed.componentId)
    const terminal = node?.data.terminals.find(
      (t) => t.id === parseSessionId(revealed.sid).terminalId,
    )
    if (node && terminal)
      entries.push({ componentId: node.id, label: node.data.name, terminal, sid: revealed.sid })
  }
  const shown = visibleTaskTerminals(
    entries,
    revealed ? [...(visible ?? entries.map((e) => e.sid)), revealed.sid] : visible,
    maximized,
  )
  return (
    <div className="workspace implementation-view">
      <header className="implementation-header">
        <TaskTabs />
        <WorktreePicker align="right" />
      </header>
      <div className="task-controls row">
        <select
          value=""
          aria-label="Start implementation agent"
          onChange={(e) => {
            const device = agents.find((d) => d.id === e.target.value)
            if (device) void startTaskAgent(device)
          }}
        >
          <option value="" disabled>
            Start implementation agent…
          </option>
          {agents.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select
          value={location}
          aria-label="Terminal location"
          onChange={(e) => setLocation(e.target.value)}
        >
          <option value={TASK_ROOT_SCOPE}>Task root</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.data.name}
            </option>
          ))}
        </select>
        <AddTerminalSelect componentId={location} />
        <select
          value={split}
          aria-label="Terminal layout"
          onChange={(e) =>
            useStore
              .getState()
              .setPanelLayout('task-split', { orientation: Number(e.target.value) })
          }
        >
          <option value={0}>Tiles</option>
          <option value={1}>Split columns</option>
          <option value={2}>Split rows</option>
        </select>
        <span className="spacer" />
        <details className="task-terminal-filter">
          <summary>Terminals ({shown.length})</summary>
          <div className="panel">
            {entries.map((entry) => (
              <label key={entry.sid}>
                <input
                  type="checkbox"
                  checked={!visible || visible.includes(entry.sid)}
                  onChange={() => {
                    const ids = visible ?? entries.map((e) => e.sid)
                    useStore
                      .getState()
                      .setVisibleTerminals(
                        ids.includes(entry.sid)
                          ? ids.filter((id) => id !== entry.sid)
                          : [...ids, entry.sid],
                      )
                  }}
                />
                {entry.label} · {entry.terminal.name}
              </label>
            ))}
            <button onClick={() => useStore.getState().setVisibleTerminals(null)}>Show all</button>
          </div>
        </details>
        <select
          value=""
          disabled={!highlighted.length}
          aria-label="Start agents per component"
          onChange={(e) => {
            const device = agents.find((d) => d.id === e.target.value)
            if (device) void startAgentsIn(highlighted, device, task)
          }}
        >
          <option value="" disabled>
            Start agents per component…
          </option>
          {agents.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="task-scope scope-chips" aria-label="Task component filters">
        {nodes.map((n) => (
          <button
            key={n.id}
            className={`chip ${highlighted.includes(n.id) ? 'active' : 'off'}`}
            aria-pressed={highlighted.includes(n.id)}
            onClick={() => useStore.getState().toggleHighlight(n.id)}
          >
            {n.data.name}
          </button>
        ))}
      </div>
      <TaskActivityPanel />
      <div className="implementation-terminals">
        {shown.length ? (
          <TaskTerminals key={`${projectId}/${task}`} entries={shown} />
        ) : (
          <EmptyState icon="›_" title="No terminals shown">
            <button onClick={() => useStore.getState().setVisibleTerminals(null)}>
              Show terminals
            </button>
          </EmptyState>
        )}
      </div>
    </div>
  )
}
