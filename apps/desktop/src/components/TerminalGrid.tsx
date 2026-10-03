import { describeTerminal, terminalHealth } from '../lib/display'
import { startTerminal, stopTerminal } from '../lib/sessions'
import { useStore } from '../store'
import { sessionId, type TerminalSpec } from '../types'
import TerminalPane from './TerminalPane'

/** Shared tiled sessions for the implementation view and component pop-outs. */
export default function TerminalGrid({
  componentId,
  terminals,
}: {
  componentId: string
  terminals: TerminalSpec[]
}) {
  const sessions = useStore((s) => s.sessions)
  return (
    <div className="terminal-grid">
      {terminals.map((terminal) => {
        const sid = sessionId(componentId, terminal.id)
        const session = sessions[sid]
        return (
          <section key={sid} className={`terminal-tile health-${terminalHealth(session)}`}>
            <div className="terminal-tile-header">
              <span className="status-dot" />
              <strong>{terminal.name}</strong>
              <code title={describeTerminal(terminal)}>{describeTerminal(terminal)}</code>
              {session?.running ? (
                <button onClick={() => stopTerminal(sid)}>■ Stop</button>
              ) : (
                <button onClick={() => void startTerminal(componentId, terminal.id)}>
                  ▶ {session ? 'Restart' : 'Start'}
                </button>
              )}
            </div>
            <TerminalPane componentId={componentId} terminal={terminal} focus={false} />
          </section>
        )
      })}
      {terminals.length === 0 && (
        <div className="hint">No terminals configured for this component.</div>
      )}
    </div>
  )
}
