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
import { roleDevice } from '../lib/agentRoles'
import { nearbyIds, planTerminals } from '../lib/plan'
import { restartTerminal } from '../lib/sessions'
import { activeTaskOf, refreshTasks, seedNewTask } from '../lib/tasks'
import { useStore } from '../store'
import { PLAN_SCOPE, plannerSessionId, type PlannerProposal } from '../types'
import Canvas from './Canvas'
import Menu, { MenuItem } from './Menu'
import StatusLabel from './status/StatusLabel'
import TerminalPane from './TerminalPane'
import TerminalControl from './TerminalControl'
import WorktreePicker from './tasks/WorktreePicker'

import { planDrafts } from '../lib/planDrafts'
import { implementPlannerPlan } from '../lib/planHandoff'

export default function PlanView() {
  const project = useStore((s) => s.project)
  const nodes = useStore((s) => s.nodes)
  const edges = useStore((s) => s.edges)
  const devices = useStore((s) => s.devices)
  const highlighted = useStore((s) => s.highlighted)
  const startedWith = useStore((s) => s.planStartedWith)
  const sessions = useStore((s) => s.sessions)
  const task = useStore((s) => s.activeTask)
  const taskTitle = useStore((s) => activeTaskOf(s)?.title)
  useClockTick()
  const toggleHighlight = useStore((s) => s.toggleHighlight)
  const clearHighlights = useStore((s) => s.clearHighlights)
  const activeId = useStore((s) => s.planActive)
  const roles = useStore((s) => s.agentRoles)
  const setActiveId = useStore((s) => s.setPlanActive)
  const proposalKey = project?.id ?? ''
  const [proposalResult, setProposalResult] = useState<{
    key: string
    value: PlannerProposal | null
  }>({ key: '', value: null })
  const proposal = proposalResult.key === proposalKey ? proposalResult.value : null
  // Outline the proposed components on the canvas until the proposal is applied.
  const proposedIds = proposal?.assignments.map((a) => a.componentId).join('\n') ?? ''
  useEffect(() => {
    useStore.getState().setProposedScope(proposedIds ? proposedIds.split('\n') : [])
    return () => useStore.getState().setProposedScope([])
  }, [proposedIds])
  const [proposalBusy, setProposalBusy] = useState(false)
  const [proposalError, setProposalError] = useState('')
  const [contextOpen, setContextOpen] = useState(false)
  const [context, setContext] = useState('Loading planner context…')
  const [restarting, setRestarting] = useState(false)
  const [implementing, setImplementing] = useState(false)
  const [handoffResult, setHandoffResult] = useState({ key: '', error: '' })
  const [planLoads, setPlanLoads] = useState(0)
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
  const planRole = roleDevice(devices, roles, 'plan').id
  // Until a tab is picked, the project's plan agent is shown.
  const active =
    terminals.find((t) => t.id === activeId) ??
    terminals.find((t) => t.id === planRole) ??
    terminals[0]
  const sid = plannerSessionId(active.id)
  const session = sessions[sid]
  const nearby = nearbyIds(highlighted, edges)
  const stale = session?.running && startedWith[sid] !== [...highlighted].sort().join(',')

  useEffect(() => {
    if (!contextOpen || !project) return
    let disposed = false
    void planContext(useStore.getState().toProject(), highlighted)
      .then((text) => {
        if (!disposed) setContext(text)
      })
      .catch((e) => {
        if (!disposed) setContext(String(e))
      })
    return () => {
      disposed = true
    }
  }, [contextOpen, project, nodes, edges, highlighted])

  const projectId = project?.id
  useEffect(() => {
    if (!projectId) return
    let disposed = false
    const load = () =>
      proposalRead(projectId)
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
      if (event.projectId === projectId && !event.task) {
        void load()
        if (!planDrafts.has(`${projectId}\n`)) setPlanLoads((n) => n + 1)
      }
    })
    return () => {
      disposed = true
      void unlisten.then((stop) => stop())
    }
  }, [projectId, proposalKey])
  const applyProposal = async () => {
    if (!projectId || !proposal) return
    const map = useStore.getState().toProject()
    const targetTask = task
    setProposalBusy(true)
    setProposalError('')
    try {
      const ids = await proposalApply(map, undefined, proposal, targetTask ?? undefined)
      setProposalResult({ key: proposalKey, value: null })
      useStore.getState().patchTask(projectId, targetTask, {
        highlighted: ids,
        implementationComponents: ids.map((id) => ({ id, visible: true })),
      })
      await refreshTasks(projectId)
      if (useStore.getState().project?.id === projectId) loadPlan()
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
  const planKey = projectId ? `${projectId}\n` : null
  // Which worktree a handoff targeted, so switching away hides its error.
  const handoffKey = `${projectId ?? ''}\n${task ?? ''}`
  const handoffError = handoffResult.key === handoffKey ? handoffResult.error : ''
  // Which plan a finished save belongs to, so a project switch mid-save doesn't show its result.
  const currentKey = useRef(planKey)
  useEffect(() => {
    currentKey.current = planKey
  }, [planKey])
  // The plan the editor holds; edits wait until it matches the current project.
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  useEffect(() => {
    if (!planOpen || !projectId || !planKey) return
    let disposed = false
    const draft = planDrafts.get(planKey)
    const load = draft
      ? Promise.resolve({ ...draft, cut: false })
      : planRead(projectId).then(({ text, cut }) => ({
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
  }, [planOpen, projectId, planKey, planLoads])
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
      const saved = await planWrite(projectId, undefined, text, overwrite ? null : planBase)
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
      await restartTerminal(PLAN_SCOPE, active.id)
    } finally {
      setRestarting(false)
    }
  }

  /** Hand the plan to the active worktree, which is `key` (see `handoffKey`). */
  const implement = async (key = handoffKey) => {
    if (implementing) return
    setImplementing(true)
    setHandoffResult({ key, error: '' })
    try {
      await implementPlannerPlan(active.id)
    } catch (e) {
      setHandoffResult({ key, error: String(e) })
    } finally {
      setImplementing(false)
    }
  }
  const implementLabel = implementing ? 'Starting implementation…' : 'Implement →'

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
              <WorktreePicker copyPlan />
              <button
                title="Create a branch and worktree for the highlighted components, or the selected one, starting with a copy of the plan. The planner and its plan stay."
                onClick={() => seedNewTask(undefined, { copyPlan: true })}
              >
                ＋ New task
              </button>
            </div>
            <div className="row plan-implement">
              {task ? (
                <button
                  disabled={implementing || proposalBusy}
                  title={`Pass the plan to ${active.name} in ${taskTitle ?? 'this worktree'} and start implementation`}
                  onClick={() => void implement()}
                >
                  {implementing ? implementLabel : `Implement in ${taskTitle ?? 'worktree'} →`}
                </button>
              ) : implementing || proposalBusy ? (
                <button disabled>{implementLabel}</button>
              ) : (
                // On the project folder, offer a worktree first: plans often come before one.
                <Menu label={implementLabel} title="Choose where to implement the plan">
                  <MenuItem
                    onClick={() =>
                      seedNewTask(
                        (created) => void implement(`${projectId ?? ''}\n${created.id}`),
                        { copyPlan: true },
                      )
                    }
                  >
                    New worktree…
                  </MenuItem>
                  <MenuItem onClick={() => void implement()}>Implement in project folder</MenuItem>
                </Menu>
              )}
            </div>
            {handoffError && (
              <p className="hint file-tree-error" role="alert">
                {handoffError}
              </p>
            )}
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
                  Saves this plan and assignments to the active worktree and selects its components.
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
                Belongs to the project; copied to the worktree you implement in.
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
                const tabSid = plannerSessionId(t.id)
                const status = terminalStatus(t.kind, sessions[tabSid])
                return (
                  <button
                    key={t.id}
                    className={`tab health-${status.health} ${t.id === active.id ? 'active' : ''}`}
                    title={statusTitle(status, describeTerminal(t))}
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
                <TerminalControl
                  componentId={PLAN_SCOPE}
                  terminalId={active.id}
                  sid={sid}
                  session={session}
                  task={null}
                  restarting={restarting}
                  onRestart={restart}
                />
              </span>
            </div>
            {stale && (
              <div className="planner-stale" role="status">
                Highlights changed — restart to apply
              </div>
            )}
            <TerminalPane key={sid} componentId={PLAN_SCOPE} terminal={active} task={null} />
          </div>
        </div>
      </Panel>
    </PersistedGroup>
  )
}
