import PersistedGroup from './PersistedGroup'
import { useEffect, useState } from 'react'
import { Panel, Separator } from 'react-resizable-panels'
import { describeTerminal, KIND_COLOR, statusTitle, terminalStatus } from '../lib/display'
import { useClockTick } from '../lib/clock'
import { planContext } from '../lib/ipc'
import { nearbyIds, planTerminals } from '../lib/plan'
import { restartTerminal, startTerminal, stopTerminal } from '../lib/sessions'
import { useStore } from '../store'
import { PLAN_SCOPE, sessionId } from '../types'
import Canvas from './Canvas'
import StatusLabel from './status/StatusLabel'
import TerminalPane from './TerminalPane'

export default function PlanView() {
  const project = useStore((s) => s.project)
  const nodes = useStore((s) => s.nodes)
  const edges = useStore((s) => s.edges)
  const devices = useStore((s) => s.devices)
  const highlighted = useStore((s) => s.highlighted)
  const startedWith = useStore((s) => s.planStartedWith)
  const sessions = useStore((s) => s.sessions)
  const task = useStore((s) => s.activeTask)
  const setNewTask = useStore((s) => s.setNewTask)
  useClockTick()
  const toggleHighlight = useStore((s) => s.toggleHighlight)
  const clearHighlights = useStore((s) => s.clearHighlights)
  const activeId = useStore((s) => s.planActive)
  const setActiveId = useStore((s) => s.setPlanActive)
  const [contextOpen, setContextOpen] = useState(false)
  const [context, setContext] = useState('Loading planner context…')
  const [restarting, setRestarting] = useState(false)
  const terminals = planTerminals(devices)
  const active = terminals.find((t) => t.id === activeId) ?? terminals[0]
  const sid = sessionId(PLAN_SCOPE, active.id, task)
  const session = sessions[sid]
  const nearby = nearbyIds(highlighted, edges)
  const stale = session?.running && startedWith[sid] !== [...highlighted].sort().join(',')

  useEffect(() => {
    if (!contextOpen || !project) return
    let disposed = false
    void planContext(useStore.getState().toProject(), highlighted, task ?? undefined)
      .then((text) => {
        if (!disposed) setContext(text)
      })
      .catch((e) => {
        if (!disposed) setContext(String(e))
      })
    return () => {
      disposed = true
    }
  }, [contextOpen, project, nodes, edges, highlighted, task])

  const restart = async () => {
    setRestarting(true)
    try {
      await restartTerminal(PLAN_SCOPE, active.id, task)
    } finally {
      setRestarting(false)
    }
  }

  return (
    <PersistedGroup layoutId="PlanView-1" orientation="vertical" className="workspace">
      <Panel id="PlanView-pane-1" defaultSize="45" minSize="20">
        <Canvas />
      </Panel>
      <Separator className="separator horizontal" />
      <Panel id="PlanView-pane-2" defaultSize="55" minSize="20">
        <div className="plan-dock">
          <aside className="plan-scope">
            <div className="row">
              <span className="section-title">Planner scope</span>
              <span className="spacer" />
              <button disabled={highlighted.length === 0} onClick={clearHighlights}>
                Clear
              </button>
              <button
                disabled={highlighted.length === 0}
                title="Create a branch and worktree for the highlighted components"
                onClick={() => setNewTask([...highlighted])}
              >
                Start task…
              </button>
            </div>
            <div className="hint flush">
              {highlighted.length
                ? `${highlighted.length} highlighted · ${nearby.size} nearby`
                : 'Whole project — click components to focus the plan.'}
            </div>
            <div className="scope-chips">
              {highlighted.map((id) => {
                const node = nodes.find((n) => n.id === id)
                if (!node) return null
                return (
                  <button
                    key={id}
                    className="chip"
                    onClick={() => toggleHighlight(id)}
                    aria-label={`Remove ${node.data.name} from planner scope`}
                  >
                    <span className="kind-dot" style={{ background: KIND_COLOR[node.data.kind] }} />
                    {node.data.name} ×
                  </button>
                )
              })}
            </div>
            <details
              className="context"
              open={contextOpen}
              onToggle={(e) => setContextOpen(e.currentTarget.open)}
            >
              <summary>Planner context</summary>
              <pre>{context}</pre>
            </details>
          </aside>
          <div className="terminal-dock planner-terminal">
            <div className="tabs">
              {terminals.map((t) => {
                const tabSid = sessionId(PLAN_SCOPE, t.id, task)
                const status = terminalStatus(t.kind, sessions[tabSid])
                return (
                  <button
                    key={t.id}
                    className={`tab health-${status.health} ${t.id === active.id ? 'active' : ''}`}
                    title={statusTitle(status)}
                    onClick={() => setActiveId(t.id)}
                  >
                    <span className="status-dot" />
                    {t.name}
                  </button>
                )
              })}
              <span className="spacer" />
              <span className="tab-actions">
                <StatusLabel status={terminalStatus(active.kind, session)} />
                <code>{describeTerminal(active)}</code>
                {session?.running ? (
                  <>
                    <button disabled={restarting} onClick={() => stopTerminal(sid)}>
                      ■ Stop
                    </button>
                    <button disabled={restarting} onClick={() => void restart()}>
                      ↻ Restart
                    </button>
                  </>
                ) : (
                  <button
                    disabled={restarting}
                    onClick={() => void startTerminal(PLAN_SCOPE, active.id, task)}
                  >
                    ▶ {restarting ? 'Stopping…' : session ? 'Restart' : 'Start'}
                  </button>
                )}
              </span>
            </div>
            {stale && (
              <div className="planner-stale" role="status">
                Highlights changed — restart to apply
              </div>
            )}
            <TerminalPane key={sid} componentId={PLAN_SCOPE} terminal={active} />
          </div>
        </div>
      </Panel>
    </PersistedGroup>
  )
}
