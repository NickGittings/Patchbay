import { useState } from 'react'
import { describeTerminal, terminalStatus } from '../lib/display'
import { openComponentWindow } from '../lib/windows'
import { removeTaskTerminal, startTerminal, stopTerminal } from '../lib/sessions'
import type { TaskTerminal } from '../lib/taskTerminals'
import { TASK_ROOT_SCOPE } from '../types'
import { useStore } from '../store'
import StatusLabel from './status/StatusLabel'
import TerminalPane from './TerminalPane'

export default function TaskTerminals({ entries }: { entries: TaskTerminal[] }) {
  const sessions = useStore((s) => s.sessions)
  const maximized = useStore((s) => s.maximizedTerminal)
  const focused = useStore((s) => s.activeSession)
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
          <strong>{terminal.name}</strong>
          {componentId !== TASK_ROOT_SCOPE && <span className="hint flush">{label}</span>}
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
          <button
            aria-label={`Remove ${terminal.name}`}
            title="Remove from this task"
            onClick={() => {
              if (session?.running && !window.confirm(`Stop ${terminal.name} and remove it?`))
                return
              void removeTaskTerminal(componentId, terminal.id, sid)
            }}
          >
            ×
          </button>
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
  return (
    <div
      className={`terminal-grid task-terminal-grid ${entries.some((e) => e.sid === maximized) ? 'has-maximized' : ''}`}
    >
      {entries.map(tile)}
    </div>
  )
}
