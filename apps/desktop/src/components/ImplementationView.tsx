import { KIND_COLOR } from '../lib/display'
import { startTerminal } from '../lib/sessions'
import { openComponentWindow } from '../lib/windows'
import { useStore } from '../store'
import { sessionId } from '../types'
import TerminalGrid from './TerminalGrid'

export default function ImplementationView() {
  const nodes = useStore((s) => s.nodes)
  const selectedId = useStore((s) => s.selectedId)
  const highlighted = useStore((s) => s.highlighted)
  const sessions = useStore((s) => s.sessions)
  const gitChanges = useStore((s) => s.gitChanges)
  const select = useStore((s) => s.select)
  const target =
    nodes.find((n) => n.id === selectedId) ?? nodes.find((n) => n.id === highlighted[0]) ?? nodes[0]
  const stopped =
    target?.data.terminals.filter(
      (t) => t.kind !== 'shell' && !sessions[sessionId(target.id, t.id)]?.running,
    ) ?? []

  return (
    <div className="workspace implementation-view">
      <header className="implementation-header">
        <div className="component-switcher" role="group" aria-label="Component">
          {nodes.map((n) => {
            const running = n.data.terminals.filter(
              (t) => sessions[sessionId(n.id, t.id)]?.running,
            ).length
            const changes = gitChanges[n.id] ?? 0
            return (
              <button
                key={n.id}
                className={`component-pill ${target?.id === n.id ? 'active' : ''}`}
                aria-pressed={target?.id === n.id}
                onClick={() => select(n.id)}
              >
                <span className="kind-dot" style={{ background: KIND_COLOR[n.data.kind] }} />
                {n.data.name}
                {changes > 0 && (
                  <span className="git-badge" title={`${changes} uncommitted change(s)`}>
                    ±{changes}
                  </span>
                )}
                {running > 0 && (
                  <span className="count running" title={`${running} running`}>
                    {running}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        {target && (
          <>
            <button onClick={() => void openComponentWindow(target.id, target.data.name)}>
              ⧉ Pop out
            </button>
            <button
              disabled={stopped.length === 0}
              onClick={() => {
                for (const t of stopped) void startTerminal(target.id, t.id)
              }}
            >
              ▶ Start all
            </button>
          </>
        )}
      </header>
      <div className="implementation-terminals">
        {target ? (
          <TerminalGrid componentId={target.id} terminals={target.data.terminals} />
        ) : (
          <div className="hint">Add a component in Navigation to configure terminals.</div>
        )}
      </div>
    </div>
  )
}
