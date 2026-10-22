import { retainedTerminal, shownTaskTerminals, taskTerminals } from '../lib/taskTerminals'
import { useStore } from '../store'
import { parseSessionId } from '../types'
import EmptyState from './EmptyState'
import TaskTerminals from './TaskTerminals'
import { ActivityStatus, RunSelect } from './tasks/TaskActivityPanel'
import TaskActions from './tasks/TaskActions'

export default function ImplementationView() {
  const sessions = useStore((s) => s.sessions)
  const nodes = useStore((s) => s.nodes)
  const projectId = useStore((s) => s.project?.id) ?? ''
  const rootTerminals = useStore((s) => s.rootTerminals)
  const componentTerminals = useStore((s) => s.componentTerminals)
  const runtimes = useStore((s) => s.runtimeTerminals)
  const task = useStore((s) => s.activeTask)
  const maximized = useStore((s) => s.maximizedTerminal)
  const revealed = useStore((s) => s.revealed)
  const entries = taskTerminals(
    { rootTerminals, componentTerminals },
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
    else if (runtimes[revealed.sid])
      entries.push(retainedTerminal(revealed.sid, runtimes[revealed.sid], nodes))
  }
  const shown = shownTaskTerminals(entries, maximized)
  return (
    <div className="workspace implementation-view">
      <div className="task-controls row">
        <RunSelect />
        <span className="spacer" />
        <TaskActions />
      </div>
      <ActivityStatus />
      <div className="implementation-terminals">
        {shown.length ? (
          <TaskTerminals key={`${projectId}/${task}`} entries={shown} />
        ) : (
          <EmptyState icon="›_" title="No terminals in this task">
            Start an agent or add a terminal above.
          </EmptyState>
        )}
      </div>
    </div>
  )
}
