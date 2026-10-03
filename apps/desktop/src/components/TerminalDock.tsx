import { describeTerminal, terminalHealth } from '../lib/display'
import { startTerminal, stopTerminal } from '../lib/sessions'
import { useStore } from '../store'
import { sessionId, type TerminalSpec } from '../types'
import TerminalPane from './TerminalPane'

interface Tab {
  sid: string
  componentId: string
  terminal: TerminalSpec
  label: string
}

/** Tabs for the selected component's terminals, or every started session when nothing is selected. */
function useTabs(): Tab[] {
  const nodes = useStore((s) => s.nodes)
  const selectedId = useStore((s) => s.selectedId)
  const sessions = useStore((s) => s.sessions)

  const all = nodes.flatMap((n) =>
    n.data.terminals.map((t) => ({
      sid: sessionId(n.id, t.id),
      componentId: n.id,
      terminal: t,
      label: selectedId ? t.name : `${n.data.name} · ${t.name}`,
    })),
  )
  return selectedId
    ? all.filter((t) => t.componentId === selectedId)
    : all.filter((t) => sessions[t.sid])
}

export default function TerminalDock() {
  const tabs = useTabs()
  const sessions = useStore((s) => s.sessions)
  const activeSession = useStore((s) => s.activeSession)
  const setActiveSession = useStore((s) => s.setActiveSession)
  const active = tabs.find((t) => t.sid === activeSession) ?? null
  const session = active ? sessions[active.sid] : undefined

  return (
    <div className="panel terminal-dock">
      <div className="tabs">
        {tabs.map((t) => (
          <button
            key={t.sid}
            className={`tab health-${terminalHealth(sessions[t.sid])} ${
              t.sid === activeSession ? 'active' : ''
            }`}
            onClick={() => setActiveSession(t.sid)}
          >
            <span className="status-dot" />
            {t.label}
          </button>
        ))}
        {tabs.length === 0 && (
          <span className="hint">Select a component to see its terminals.</span>
        )}
        <span className="spacer" />
        {active && (
          <span className="tab-actions">
            <code>{describeTerminal(active.terminal)}</code>
            {session?.running ? (
              <button onClick={() => stopTerminal(active.sid)}>■ Stop</button>
            ) : (
              <button onClick={() => void startTerminal(active.componentId, active.terminal.id)}>
                ▶ {session ? 'Restart' : 'Start'}
              </button>
            )}
          </span>
        )}
      </div>
      {active ? (
        <TerminalPane
          key={active.sid}
          componentId={active.componentId}
          terminal={active.terminal}
        />
      ) : (
        <div className="terminal-area" />
      )}
    </div>
  )
}
