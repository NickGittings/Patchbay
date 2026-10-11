import PersistedGroup from './PersistedGroup'
import { useEffect, useRef, useState } from 'react'
import { Panel, Separator } from 'react-resizable-panels'
import { describeTerminal, KIND_COLOR, statusTitle, terminalStatus } from '../lib/display'
import { useClockTick } from '../lib/clock'
import {
  onProposal,
  planContext,
  planRead,
  planWrite,
  proposalRead,
  proposalApply,
} from '../lib/ipc'
import { nearbyIds, planTerminals } from '../lib/plan'
import { restartTerminal, startTerminal, stopTerminal } from '../lib/sessions'
import { refreshTasks, seedNewTask } from '../lib/tasks'
import { useStore } from '../store'
import { PLAN_SCOPE, sessionId, type PlannerProposal } from '../types'
import Canvas from './Canvas'
import StatusLabel from './status/StatusLabel'
import TerminalPane from './TerminalPane'
import WorktreePicker from './tasks/WorktreePicker'

/**
 * Unsaved Saved-plan edits per project and task, kept outside the component so leaving the view or
 * switching task doesn't discard them; `overwrite` remembers that the planner's newer file may be
 * replaced.
 */
const planDrafts = new Map<string, { text: string; base: string; overwrite: boolean }>()

export default function PlanView() {
  const project = useStore((s) => s.project)
  const nodes = useStore((s) => s.nodes)
  const edges = useStore((s) => s.edges)
  const devices = useStore((s) => s.devices)
  const highlighted = useStore((s) => s.highlighted)
  const startedWith = useStore((s) => s.planStartedWith)
  const sessions = useStore((s) => s.sessions)
  const task = useStore((s) => s.activeTask)
  const setView = useStore((s) => s.setView)
  useClockTick()
  const toggleHighlight = useStore((s) => s.toggleHighlight)
  const clearHighlights = useStore((s) => s.clearHighlights)
  const activeId = useStore((s) => s.planActive)
  const setActiveId = useStore((s) => s.setPlanActive)
  const proposalKey = `${project?.id ?? ''}/${task ?? ''}`
  const [proposalResult, setProposalResult] = useState<{
    key: string
    value: PlannerProposal | null
  }>({ key: '', value: null })
  const proposal = proposalResult.key === proposalKey ? proposalResult.value : null
  const [proposalBusy, setProposalBusy] = useState(false)
  const [proposalError, setProposalError] = useState('')
  const [contextOpen, setContextOpen] = useState(false)
  const [context, setContext] = useState('Loading planner context…')
  const [restarting, setRestarting] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [plan, setPlan] = useState('')
  // The file as last read or written, to tell edits apart and notice the planner rewriting it.
  const [planBase, setPlanBase] = useState('')
  const [planState, setPlanState] = useState<'loading' | 'ready' | 'saving' | string>('loading')
  // The planner rewrote the file since it was loaded; the next Save replaces it anyway.
  const [overwrite, setOverwrite] = useState(false)
  // The file is longer than the editor holds, so saving would lose the rest.
  const [planCut, setPlanCut] = useState(false)
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

  const projectId = project?.id
  useEffect(() => {
    if (!projectId) return
    let disposed = false
    const load = () =>
      proposalRead(projectId, task ?? undefined)
        .then((value) => {
          if (!disposed) {
            setProposalResult({ key: proposalKey, value })
            setProposalError('')
          }
        })
        .catch((e) => {
          if (!disposed) setProposalError(String(e))
        })
    void load()
    // A planner's submission is the only other writer of the pending proposal.
    const unlisten = onProposal((event) => {
      if (event.projectId === projectId && (event.task ?? null) === (task ?? null)) void load()
    })
    return () => {
      disposed = true
      void unlisten.then((stop) => stop())
    }
  }, [projectId, task, proposalKey])
  const applyProposal = async () => {
    if (!projectId || !proposal) return
    const map = useStore.getState().toProject()
    const targetTask = task
    setProposalBusy(true)
    setProposalError('')
    try {
      const ids = await proposalApply(map, targetTask ?? undefined, proposal)
      useStore.getState().patchTask(projectId, targetTask, {
        highlighted: ids,
        implementationComponents: ids.map((id) => ({ id, visible: true })),
      })
      await refreshTasks(projectId)
      if (
        useStore.getState().project?.id === projectId &&
        useStore.getState().activeTask === targetTask
      )
        loadPlan()
    } catch (e) {
      if (
        useStore.getState().project?.id === projectId &&
        useStore.getState().activeTask === targetTask
      )
        setProposalError(String(e))
    } finally {
      setProposalBusy(false)
    }
  }
  const planKey = projectId ? `${projectId}\n${task ?? ''}` : null
  // Which plan a finished save belongs to, so a task switch mid-save doesn't show its result.
  const currentKey = useRef(planKey)
  useEffect(() => {
    currentKey.current = planKey
  }, [planKey])
  const [planLoads, setPlanLoads] = useState(0)
  // The plan the editor holds; edits wait until it matches the current project and task.
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  useEffect(() => {
    if (!planOpen || !projectId || !planKey) return
    let disposed = false
    const draft = planDrafts.get(planKey)
    const load = draft
      ? Promise.resolve({ ...draft, cut: false })
      : planRead(projectId, task ?? undefined).then(({ text, cut }) => ({
          text,
          base: text,
          overwrite: false,
          cut,
        }))
    load
      .then((loaded) => {
        if (disposed) return
        setPlan(loaded.text)
        setPlanBase(loaded.base)
        setOverwrite(loaded.overwrite)
        setPlanCut(loaded.cut)
        setLoadedKey(planKey)
        setPlanState('ready')
      })
      .catch((e) => {
        if (!disposed) setPlanState(String(e))
      })
    return () => {
      disposed = true
    }
  }, [planOpen, projectId, planKey, task, planLoads])
  const editPlan = (text: string) => {
    if (!planKey) return
    setPlan(text)
    if (text === planBase && !overwrite) planDrafts.delete(planKey)
    else planDrafts.set(planKey, { text, base: planBase, overwrite })
  }
  const loadPlan = () => {
    if (planKey) planDrafts.delete(planKey)
    setPlanState('loading')
    setPlanLoads((n) => n + 1)
  }

  /** Save the editor's plan; `false` when it wasn't saved (a conflict or an error). */
  const savePlan = async () => {
    if (!projectId || !planKey) return false
    const key = planKey
    const text = plan
    setPlanState('saving')
    try {
      // The backend replaces the file only while it still holds what was loaded, unless the
      // user chose to replace the planner's newer version.
      const saved = await planWrite(projectId, task ?? undefined, text, overwrite ? null : planBase)
      if (!saved) {
        planDrafts.set(key, { text, base: planBase, overwrite: true })
        if (currentKey.current === key) {
          setOverwrite(true)
          setPlanState('ready')
        }
        return false
      }
      planDrafts.delete(key)
      if (currentKey.current === key) {
        setPlanBase(text)
        setOverwrite(false)
        setPlanState('ready')
      }
      return true
    } catch (e) {
      if (currentKey.current === key) setPlanState(String(e))
      return false
    }
  }
  const planBusy = planState === 'loading' || planState === 'saving' || loadedKey !== planKey
  const planEdited = plan !== planBase

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
            <div className="row plan-scope-header">
              <span className="section-title">Planner scope</span>
              <span className="spacer" />
              <button disabled={highlighted.length === 0} onClick={clearHighlights}>
                Clear
              </button>
              <WorktreePicker />
              <button
                title="Create a branch and worktree for the highlighted components, or the selected one"
                onClick={seedNewTask}
              >
                ＋ New task
              </button>
            </div>
            <div className="row plan-implement">
              <button
                disabled={highlighted.length === 0}
                title="Work on the highlighted components side by side"
                onClick={() => setView('implementation')}
              >
                Implement →
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
            {proposal && (
              <details className="context proposed-scope" open>
                <summary>Proposed scope · {proposal.assignments.length} components</summary>
                {proposal.assignments.map((entry) => (
                  <div key={entry.componentId}>
                    <strong>
                      {nodes.find((n) => n.id === entry.componentId)?.data.name ??
                        entry.componentId}
                    </strong>
                    <p>{entry.assignment}</p>
                  </div>
                ))}
                <pre>{proposal.plan}</pre>
                <button
                  className="primary"
                  disabled={proposalBusy}
                  onClick={() => void applyProposal()}
                >
                  {proposalBusy ? 'Applying…' : 'Apply selection'}
                </button>
                <p className="hint flush">
                  Saves this plan and assignments and selects this task's components.
                </p>
              </details>
            )}
            {proposalError && <p className="hint file-tree-error">{proposalError}</p>}
            <details
              className="context"
              open={contextOpen}
              onToggle={(e) => setContextOpen(e.currentTarget.open)}
            >
              <summary>Planner context</summary>
              <pre>{context}</pre>
            </details>
            <details
              className="context plan-file"
              open={planOpen}
              onToggle={(e) => setPlanOpen(e.currentTarget.open)}
            >
              <summary>Saved plan</summary>
              <div className="hint flush">
                The planner writes it to <code>$PATCHBAY_PLAN_FILE</code>; implementation agents
                started afterwards get it in their briefing.
              </div>
              <textarea
                className="mono"
                spellCheck={false}
                rows={10}
                placeholder="No plan saved yet. Ask the planner to write it, or paste one here."
                value={plan}
                disabled={planBusy}
                readOnly={planCut}
                onChange={(e) => editPlan(e.target.value)}
              />
              <div className="row">
                <span className="hint flush">
                  {planCut
                    ? 'The plan is longer than 64 KiB, so only its start is shown; edit the file itself.'
                    : overwrite
                      ? 'The planner rewrote the plan since it was loaded. Reload to see it, or Save again to replace it.'
                      : !['loading', 'ready', 'saving'].includes(planState)
                        ? planState
                        : planEdited
                          ? 'Unsaved changes · saving clears applied assignments'
                          : ''}
                </span>
                <span className="spacer" />
                <button
                  disabled={planBusy || planCut || !plan}
                  title="Empty the plan, so agents started afterwards get none"
                  onClick={() => editPlan('')}
                >
                  Clear
                </button>
                <button disabled={planBusy} onClick={() => loadPlan()}>
                  Reload
                </button>
                <button
                  disabled={planBusy || planCut || !(planEdited || overwrite)}
                  onClick={() => void savePlan()}
                >
                  Save
                </button>
              </div>
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
