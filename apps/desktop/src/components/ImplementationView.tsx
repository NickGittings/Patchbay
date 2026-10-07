import { useState } from 'react'
import { componentAttention } from '../lib/attention'
import { useClockTick } from '../lib/clock'
import { KIND_COLOR } from '../lib/display'
import { startAgentsIn } from '../lib/implement'
import { agentDevices } from '../lib/plan'
import { closeTerminal, startTerminal } from '../lib/sessions'
import { openComponentWindow } from '../lib/windows'
import { useStore, type FlowNode, type ImplementationComponent } from '../store'
import { sessionId } from '../types'
import AddTerminalSelect from './AddTerminalSelect'
import AttentionPill from './status/AttentionPill'
import TerminalGrid from './TerminalGrid'
import EmptyState from './EmptyState'
import WorktreePicker from './tasks/WorktreePicker'

/**
 * One ordered scope backs both the header pills and the visible terminal groups.
 * Entering without highlights shows the selection; pills toggle visibility or remove entries.
 */
export default function ImplementationView() {
  const nodes = useStore((s) => s.nodes)
  const selectedId = useStore((s) => s.selectedId)
  const highlighted = useStore((s) => s.highlighted)
  const implementationComponents = useStore((s) => s.implementationComponents)
  const setImplementationScope = useStore((s) => s.setImplementationScope)
  const revealed = useStore((s) => s.revealed)
  const sessions = useStore((s) => s.sessions)
  const runtimeTerminals = useStore((s) => s.runtimeTerminals)
  const task = useStore((s) => s.activeTask)
  const gitChanges = useStore((s) => s.gitChanges)
  const devices = useStore((s) => s.devices)
  const setView = useStore((s) => s.setView)
  const [maximized, setMaximized] = useState<string | null>(null)
  useClockTick()
  const fallback =
    nodes.find((n) => n.id === selectedId) ?? nodes.find((n) => n.id === highlighted[0]) ?? nodes[0]
  const scope: ImplementationComponent[] =
    implementationComponents ??
    (highlighted.length ? highlighted : fallback ? [fallback.id] : []).map((id) => ({
      id,
      visible: true,
    }))
  const listedScope = scope.filter((c) => nodes.some((n) => n.id === c.id))
  // Reveals remain temporary and do not change the Plan scope.
  const extra =
    revealed && !listedScope.some((c) => c.id === revealed.componentId && c.visible)
      ? nodes.find((n) => n.id === revealed.componentId)
      : undefined
  const listed = listedScope.map((c) => nodes.find((n) => n.id === c.id)!)
  if (extra && !listed.some((n) => n.id === extra.id)) listed.push(extra)
  const shown = listed.filter(
    (n) => n.id === extra?.id || listedScope.some((c) => c.id === n.id && c.visible),
  )
  // A new reveal un-maximizes any other tile, which would hide the revealed one.
  const [seenReveal, setSeenReveal] = useState(revealed)
  if (seenReveal !== revealed) {
    setSeenReveal(revealed)
    if (revealed && maximized !== revealed.sid) setMaximized(null)
  }
  const shownIds = new Set(shown.map((n) => n.id))
  const listedIds = new Set(listed.map((n) => n.id))
  const inactive = nodes.filter((n) => !listedIds.has(n.id))
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

  const updateScope = (components: ImplementationComponent[]) => {
    setImplementationScope(components)
    setMaximized(null)
  }
  const editableScope = listed.map((n) => ({ id: n.id, visible: shownIds.has(n.id) }))
  const onPill = (n: FlowNode) => {
    updateScope(editableScope.map((c) => (c.id === n.id ? { ...c, visible: !c.visible } : c)))
  }
  const removeComponent = (id: string) => {
    updateScope(editableScope.filter((c) => c.id !== id))
  }
  const addComponent = (id: string) => {
    if (inactive.some((n) => n.id === id)) updateScope([...editableScope, { id, visible: true }])
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
            onClose={(terminalId) => closeTerminal(n.id, terminalId)}
          />
        </section>
      ))}
    </div>
  )

  return (
    <div className="workspace implementation-view">
      <header className="implementation-header">
        <div className="component-switcher" role="group" aria-label="Implementation components">
          {listed.map((n) => {
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
            const visible = shownIds.has(n.id)
            return (
              <div key={n.id} className={`component-pill-container${visible ? ' active' : ''}`}>
                <button
                  className={`component-pill${visible ? ' active' : ''}`}
                  aria-pressed={visible}
                  title={`${visible ? 'Hide' : 'Show'} ${n.data.name}`}
                  onClick={() => onPill(n)}
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
                <button
                  className="component-remove"
                  aria-label={`Remove ${n.data.name} from Implementation`}
                  title={`Remove ${n.data.name} from Implementation`}
                  onClick={() => removeComponent(n.id)}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
        {inactive.length > 0 && (
          <select
            className="header-action add-component"
            value=""
            aria-label="Add component"
            onChange={(e) => addComponent(e.target.value)}
          >
            <option value="" disabled>
              Add component…
            </option>
            {inactive.map((n) => (
              <option key={n.id} value={n.id}>
                {n.data.name}
              </option>
            ))}
          </select>
        )}
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
        <WorktreePicker align="right" />
      </header>
      <div className="implementation-terminals">
        {shown.length ? (
          grids
        ) : (
          <EmptyState
            icon="▦"
            title={nodes.length ? 'No components shown' : 'Nothing to implement yet'}
            actions={
              !nodes.length && (
                <button onClick={() => setView('navigation')}>Go to Navigation</button>
              )
            }
          >
            {nodes.length
              ? 'Click a component above to show it, or choose Add component… to add one.'
              : 'Add a component in Navigation to configure terminals. Highlighted components open here side by side, each with its own terminals and agent.'}
          </EmptyState>
        )}
      </div>
    </div>
  )
}
