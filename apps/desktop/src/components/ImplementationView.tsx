import { useState } from 'react'
import { componentAttention } from '../lib/attention'
import { useClockTick } from '../lib/clock'
import { KIND_COLOR } from '../lib/display'
import { modifierKey } from '../lib/platform'
import { startAgentsIn } from '../lib/implement'
import { agentDevices } from '../lib/plan'
import { startTerminal } from '../lib/sessions'
import { openComponentWindow } from '../lib/windows'
import { useStore, type FlowNode } from '../store'
import { sessionId } from '../types'
import AddTerminalSelect from './AddTerminalSelect'
import AttentionPill from './status/AttentionPill'
import TerminalGrid from './TerminalGrid'
import EmptyState from './EmptyState'

/**
 * The highlighted components side by side (the same scope Plan uses), or the
 * selected one alone. ⌘/Shift-click a pill to add or remove it.
 */
export default function ImplementationView() {
  const nodes = useStore((s) => s.nodes)
  const selectedId = useStore((s) => s.selectedId)
  const highlighted = useStore((s) => s.highlighted)
  const revealed = useStore((s) => s.revealed)
  const setRevealed = useStore((s) => s.setRevealed)
  const sessions = useStore((s) => s.sessions)
  const runtimeTerminals = useStore((s) => s.runtimeTerminals)
  const task = useStore((s) => s.activeTask)
  const gitChanges = useStore((s) => s.gitChanges)
  const devices = useStore((s) => s.devices)
  const select = useStore((s) => s.select)
  const toggleHighlight = useStore((s) => s.toggleHighlight)
  const clearHighlights = useStore((s) => s.clearHighlights)
  const setView = useStore((s) => s.setView)
  const [maximized, setMaximized] = useState<string | null>(null)
  useClockTick()
  const fallback =
    nodes.find((n) => n.id === selectedId) ?? nodes.find((n) => n.id === highlighted[0]) ?? nodes[0]
  const scoped = highlighted
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is FlowNode => !!n)
  // A revealed terminal's component is shown after the highlighted ones until the scope changes.
  const extra =
    revealed && scoped.length && !scoped.some((n) => n.id === revealed.componentId)
      ? nodes.find((n) => n.id === revealed.componentId)
      : undefined
  const shown = scoped.length ? (extra ? [...scoped, extra] : scoped) : fallback ? [fallback] : []
  // A new reveal un-maximizes any other tile, which would hide the revealed one.
  const [seenReveal, setSeenReveal] = useState(revealed)
  if (seenReveal !== revealed) {
    setSeenReveal(revealed)
    if (revealed && maximized !== revealed.sid) setMaximized(null)
  }
  const shownIds = new Set(shown.map((n) => n.id))
  const stopped = shown.flatMap((n) =>
    n.data.terminals
      .filter((t) => t.kind !== 'shell' && !sessions[sessionId(n.id, t.id, task)]?.running)
      .map((t) => [n.id, t.id] as const),
  )
  const agents = agentDevices(devices)
  // Only the group holding the maximized tile is shown while one is.
  const solo = maximized
    ? shown.find((n) => n.data.terminals.some((t) => sessionId(n.id, t.id, task) === maximized))
    : undefined
  const groups = solo ? [solo] : shown

  const onPill = (id: string, add: boolean) => {
    if (add) {
      if (!highlighted.length && fallback && fallback.id !== id) toggleHighlight(fallback.id)
      toggleHighlight(id)
    } else {
      clearHighlights()
      select(id)
    }
    setRevealed(null)
    setMaximized(null)
  }

  const grids = (
    <div className={`implementation-groups ${groups.length > 1 ? 'multi' : ''}`}>
      {groups.map((n) => (
        <section key={n.id} className="implementation-group" aria-label={n.data.name}>
          <header className="implementation-group-header">
            <span className="kind-dot" style={{ background: KIND_COLOR[n.data.kind] }} />
            <strong>{n.data.name}</strong>
            <AttentionPill
              status={componentAttention(n.id, n.data.terminals, sessions, runtimeTerminals, task)}
            />
            <span className="spacer" />
            <AddTerminalSelect componentId={n.id} className="add-terminal compact" />
            <button
              className="group-popout"
              title={`Open ${n.data.name} in its own window`}
              aria-label={`Open ${n.data.name} in its own window`}
              onClick={() => void openComponentWindow(n.id, n.data.name)}
            >
              ⧉
            </button>
          </header>
          <TerminalGrid
            componentId={n.id}
            terminals={n.data.terminals}
            maximized={maximized}
            onMaximize={setMaximized}
          />
        </section>
      ))}
    </div>
  )

  return (
    <div className="workspace implementation-view">
      <header className="implementation-header">
        <div
          className="component-switcher"
          role="group"
          aria-label={`Components (${modifierKey}-click to work on several)`}
        >
          {nodes.map((n) => {
            const running = n.data.terminals.filter(
              (t) => sessions[sessionId(n.id, t.id, task)]?.running,
            ).length
            const changes = gitChanges[n.id] ?? 0
            const attention = componentAttention(
              n.id,
              n.data.terminals,
              sessions,
              runtimeTerminals,
              task,
            )
            const inScope = shownIds.has(n.id)
            return (
              <button
                key={n.id}
                className={`component-pill ${inScope ? 'active' : ''}`}
                aria-pressed={inScope}
                title={`${modifierKey}-click or Shift-click to work on several components at once`}
                onClick={(e) => onPill(n.id, e.metaKey || e.ctrlKey || e.shiftKey)}
              >
                <span className="kind-dot" style={{ background: KIND_COLOR[n.data.kind] }} />
                {n.data.name}
                {changes > 0 && (
                  <span className="git-badge" title={`${changes} uncommitted change(s)`}>
                    ±{changes}
                  </span>
                )}
                <AttentionPill status={attention} />
                {running > 0 && (
                  <span className="count running" title={`${running} running`}>
                    {running}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        {shown.length > 0 && (
          <>
            <span className="header-divider" aria-hidden />
            {agents.length > 0 && (
              <select
                className="header-action agent-in-each"
                value=""
                aria-label="Start an agent in each shown component"
                title="Start this agent in each shown component, adding it where missing"
                onChange={(e) => {
                  const device = agents.find((d) => d.id === e.target.value)
                  if (device)
                    void startAgentsIn(
                      shown.map((n) => n.id),
                      device,
                      task,
                    )
                }}
              >
                <option value="" disabled>
                  {shown.length > 1 ? '＋ Agent in each…' : '＋ Agent…'}
                </option>
                {agents.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
            <button
              className="header-action start-all"
              disabled={stopped.length === 0}
              onClick={() => {
                for (const [c, t] of stopped) void startTerminal(c, t, task)
              }}
            >
              ▶ Start all
            </button>
          </>
        )}
      </header>
      <div className="implementation-terminals">
        {shown.length ? (
          grids
        ) : (
          <EmptyState
            icon="▦"
            title="Nothing to implement yet"
            actions={<button onClick={() => setView('navigation')}>Go to Navigation</button>}
          >
            Add a component in Navigation to configure terminals. Highlighted components open here
            side by side, each with its own terminals and agent.
          </EmptyState>
        )}
      </div>
    </div>
  )
}
