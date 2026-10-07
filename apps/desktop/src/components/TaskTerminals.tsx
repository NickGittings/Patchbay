import { Fragment, useState } from 'react'
import { Panel, Separator } from 'react-resizable-panels'
import { describeTerminal, terminalStatus } from '../lib/display'
import { openComponentWindow } from '../lib/windows'
import { startTerminal, stopTerminal } from '../lib/sessions'
import { taskTerminals, type TaskTerminal } from '../lib/taskTerminals'
import { TASK_ROOT_SCOPE } from '../types'
import { useStore } from '../store'
import PersistedGroup from './PersistedGroup'
import StatusLabel from './status/StatusLabel'
import TerminalPane from './TerminalPane'

export default function TaskTerminals({ entries }: { entries: TaskTerminal[] }) {
  const sessions = useStore((s) => s.sessions)
  const maximized = useStore((s) => s.maximizedTerminal)
  const focused = useStore((s) => s.activeSession)
  const split = useStore((s) => s.panels['task-split']?.orientation ?? 0)
  const [editing, setEditing] = useState<string | null>(null)
  const tile = (entry: TaskTerminal) => {
    const { terminal, sid, componentId, label } = entry
    const session = sessions[sid]
    const status = terminalStatus(terminal.kind, session)
    const s = useStore.getState()
    return (
      <section
        className={`terminal-tile health-${status.health} ${focused === sid ? 'focused' : ''} ${maximized === sid ? 'maximized' : ''}`}
        data-component={componentId}
        data-session={sid}
        key={sid}
        onFocusCapture={() => useStore.getState().setActiveSession(sid)}
      >
        <div className="terminal-tile-header">
          <span className="status-dot" />
          <strong>
            {label} · {terminal.name}
          </strong>
          <StatusLabel status={status} />
          <code title={describeTerminal(terminal)}>{describeTerminal(terminal)}</code>
          {session?.running ? (
            <button onClick={() => stopTerminal(sid)}>■ Stop</button>
          ) : (
            <button onClick={() => void startTerminal(componentId, terminal.id)}>
              ▶ {session ? 'Restart' : 'Start'}
            </button>
          )}
          <button
            aria-label={
              maximized === sid ? `Restore ${terminal.name}` : `Maximize ${terminal.name}`
            }
            onClick={() => s.setMaximizedTerminal(maximized === sid ? null : sid)}
          >
            {maximized === sid ? '⤡' : '⤢'}
          </button>
          <button
            aria-label={`Hide ${terminal.name}`}
            onClick={() =>
              s.setVisibleTerminals(
                (
                  s.visibleTerminals ??
                  taskTerminals(
                    s,
                    s.nodes,
                    s.runtimeTerminals,
                    s.project?.id ?? '',
                    s.activeTask,
                  ).map((e) => e.sid)
                ).filter((id) => id !== sid),
              )
            }
          >
            ×
          </button>
          {componentId !== TASK_ROOT_SCOPE &&
            useStore.getState().nodes.some((n) => n.id === componentId) && (
              <button
                className="group-popout"
                aria-label={`Open ${label} in its own window`}
                onClick={() => void openComponentWindow(componentId, label)}
              >
                ⧉
              </button>
            )}
          {!entry.retained && (
            <button
              title="Configure terminal command"
              onClick={() => setEditing(editing === sid ? null : sid)}
            >
              ⚙
            </button>
          )}
        </div>
        {editing === sid && (
          <div className="row terminal-command-edit">
            <label className="grow">
              Command
              <input
                disabled={!!session?.running}
                value={terminal.command}
                onChange={(e) => {
                  const s = useStore.getState()
                  if (componentId === TASK_ROOT_SCOPE)
                    useStore.setState({
                      rootTerminals: s.rootTerminals.map((t) =>
                        t.id === terminal.id ? { ...t, command: e.target.value } : t,
                      ),
                    })
                  else s.updateTerminal(componentId, terminal.id, { command: e.target.value })
                }}
              />
            </label>
            <button onClick={() => setEditing(null)}>Done</button>
          </div>
        )}
        <TerminalPane
          componentId={componentId}
          terminal={terminal}
          focus={focused === sid}
          existingSessionId={entry.retained ? sid : undefined}
        />
      </section>
    )
  }
  if (split && entries.length > 1 && !entries.some((e) => e.sid === maximized)) {
    const orientation = split === 1 ? 'horizontal' : 'vertical'
    return (
      <PersistedGroup
        layoutId={`task-terminals-${orientation}`}
        orientation={orientation}
        className="task-terminal-splits"
      >
        {entries.map((entry, index) => (
          <Fragment key={entry.sid}>
            {index > 0 && (
              <Separator
                className={`separator ${orientation === 'horizontal' ? 'vertical' : 'horizontal'}`}
              />
            )}
            <Panel id={entry.sid} minSize="10">
              {tile(entry)}
            </Panel>
          </Fragment>
        ))}
      </PersistedGroup>
    )
  }
  return (
    <div
      className={`terminal-grid task-terminal-grid ${entries.some((e) => e.sid === maximized) ? 'has-maximized' : ''}`}
    >
      {entries.map(tile)}
    </div>
  )
}
