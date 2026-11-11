import { usePlanningTask, usePlanningSelection } from '../lib/planningScope'
import ProviderRunsPanel from './ProviderRunsPanel'
import PersistedGroup from './PersistedGroup'
import { useEffect, useRef, useState } from 'react'
import { Panel, Separator } from 'react-resizable-panels'
import { describeTerminal, KIND_COLOR, statusTitle, terminalStatus } from '../lib/display'
import { useClockTick } from '../lib/clock'
import {
  onProposal,
  planContext,
  planRead,
  planTransferPending,
  planWrite,
  proposalRead,
  proposalApply,
} from '../lib/ipc'
import { roleDevice } from '../lib/agentRoles'
import { nearbyIds, planTerminals } from '../lib/plan'
import { restartTerminal } from '../lib/sessions'
import { activeTaskOf, refreshTasks, seedNewTask, transferProjectDraft } from '../lib/tasks'
import { useStore, emptyTaskWorkspace } from '../store'
import {
  PLAN_SCOPE,
  PROJECT_DRAFT,
  planningTask,
  plannerSessionId,
  type PlannerProposal,
} from '../types'
import Canvas from './Canvas'
import StatusLabel from './status/StatusLabel'
import TerminalPane from './TerminalPane'
import TerminalControl from './TerminalControl'

import { planDrafts } from '../lib/planDrafts'
import { linkStory } from '../lib/stories'
import { implementPlannerPlan } from '../lib/planHandoff'

const EMPTY_PLANNING_WORKSPACE = emptyTaskWorkspace()

export default function PlanView() {
  const project = useStore((s) => s.project)
  const task = usePlanningTask()
  const selectDraft = usePlanningSelection((s) => s.selectDraft)
  const workspace = useStore((s) =>
    task === s.activeTask ? s : (s.taskWorkspaces[task ?? ''] ?? EMPTY_PLANNING_WORKSPACE),
  )
  const nodes = useStore((s) => s.nodes)
  const edges = useStore((s) => s.edges)
  const devices = useStore((s) => s.devices)
  const highlighted = workspace.highlighted
  const startedWith = useStore((s) => s.planStartedWith)
  const sessions = useStore((s) => s.sessions)
  const taskTitle = useStore((s) => activeTaskOf(s)?.title)
  useClockTick()
  const toggleHighlight = (id: string) =>
    project &&
    useStore.getState().patchTask(project.id, task, {
      highlighted: highlighted.includes(id)
        ? highlighted.filter((i) => i !== id)
        : [...highlighted, id],
    })
  const clearHighlights = () =>
    project && useStore.getState().patchTask(project.id, task, { highlighted: [] })
  const activeId = workspace.planActive
  const planStory = workspace.planStory
  const planStoryTerminal = workspace.planStoryTerminal
  const stories = useStore((s) => s.stories)
  const roles = useStore((s) => s.agentRoles)
  const setActiveId = (planActive: string) =>
    project && useStore.getState().patchTask(project.id, task, { planActive })
  const proposalKey = `${project?.id ?? ''}\n${task ?? ''}`
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
  const [pendingTransfer, setPendingTransfer] = useState<{ projectId: string; task: string }>()
  useEffect(() => {
    if (!project || task !== PROJECT_DRAFT) return
    let disposed = false
    void planTransferPending(project.id)
      .then((task) => {
        if (!disposed) setPendingTransfer(task ? { projectId: project.id, task } : undefined)
      })
      .catch((e) => {
        if (!disposed) setProposalError(String(e))
      })
    return () => {
      disposed = true
    }
  }, [project, task, workspace.simple?.transferTarget])
  const retryTask =
    workspace.simple?.transferTarget ??
    (pendingTransfer?.projectId === project?.id ? pendingTransfer?.task : undefined)
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
  const sid = plannerSessionId(active.id, project?.id, task)
  const session = sessions[sid]
  const story = planStoryTerminal === active.id ? (planStory ?? undefined) : undefined
  const nearby = nearbyIds(highlighted, edges)
  const stale = session?.running && startedWith[sid] !== [...highlighted].sort().join(',')

  useEffect(() => {
    if (!contextOpen || !project) return
    let disposed = false
    void planContext(useStore.getState().toProject(), highlighted, story, task)
      .then((text) => {
        if (!disposed) setContext(text)
      })
      .catch((e) => {
        if (!disposed) setContext(String(e))
      })
    return () => {
      disposed = true
    }
  }, [contextOpen, project, nodes, edges, highlighted, story, stories, task])

  const projectId = project?.id
  useEffect(() => {
    if (!projectId) return
    let disposed = false
    const load = () =>
      planRead(projectId, task ?? undefined)
        .then(() => proposalRead(projectId, task ?? undefined))
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
      if (event.projectId === projectId && event.task === planningTask(task)) {
        void load()
        if (!planDrafts.has(`${projectId}\n${task ?? ''}`)) setPlanLoads((n) => n + 1)
      }
    })
    return () => {
      disposed = true
      void unlisten.then((stop) => stop())
    }
  }, [projectId, proposalKey, task])
  const applyProposal = async () => {
    if (!projectId || !proposal) return
    const map = useStore.getState().toProject()
    const targetTask = task
    setProposalBusy(true)
    setProposalError('')
    try {
      const ids = await proposalApply(map, targetTask ?? undefined, proposal)
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
  const planKey = projectId ? `${projectId}\n${task ?? ''}` : null
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
  }, [planOpen, projectId, planKey, planLoads, task])
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

  /** Hand the plan to the active worktree, which is `key` (see `handoffKey`). */
  const implement = async (key = handoffKey) => {
    if (implementing) return
    setImplementing(true)
    setHandoffResult({ key, error: '' })
    try {
      await implementPlannerPlan(active.id, undefined, undefined, 'follow', {
        projectId: projectId!,
        task,
      })
    } catch (e) {
      setHandoffResult({ key, error: String(e) })
    } finally {
      setImplementing(false)
    }
  }
  const implementLabel = implementing ? 'Starting build…' : 'Implement →'

  return (
    <PersistedGroup layoutId="PlanView-1" orientation="vertical" className="workspace">
      <Panel id="PlanView-pane-1" defaultSize="45" minSize="20">
        <Canvas />
      </Panel>
      <Separator className="separator horizontal" />
      <Panel id="PlanView-pane-2" defaultSize="55" minSize="20">
        <div className="plan-dock">
          <aside className="plan-scope">
            <ProviderRunsPanel kind="scan" />
            <div className="row plan-scope-header">
              <span className="section-title">Planner scope</span>
              <select
                aria-label="Planning scope"
                value={task === PROJECT_DRAFT ? 'draft' : 'worktree'}
                onChange={(e) => selectDraft(e.target.value === 'draft')}
              >
                <option value="worktree">{taskTitle ?? 'Main worktree'}</option>
                <option value="draft">New project draft</option>
              </select>
              {planStory && (
                <span className="chip">
                  Story: {stories.find((s) => s.id === planStory)?.title ?? planStory}{' '}
                  <button
                    aria-label="Dismiss story"
                    onClick={() =>
                      projectId &&
                      useStore
                        .getState()
                        .patchTask(projectId, task, { planStory: null, planStoryTerminal: null })
                    }
                  >
                    ×
                  </button>
                </span>
              )}
              <span className="spacer" />
              <button disabled={highlighted.length === 0} onClick={clearHighlights}>
                Clear
              </button>
              <button
                title={
                  task === PROJECT_DRAFT
                    ? 'Transfer this draft and its history into a new worktree. Finish or stop its planner first.'
                    : 'Create a new worktree'
                }
                onClick={() =>
                  seedNewTask(
                    (created, pid) => {
                      if (planStory) void linkStory(pid, planStory, created.id)
                    },
                    { copyPlan: task === PROJECT_DRAFT, components: highlighted },
                  )
                }
              >
                ＋ New task
              </button>
            </div>
            <div className="row plan-implement">
              {task === PROJECT_DRAFT ? (
                retryTask ? (
                  <button
                    disabled={implementing}
                    onClick={async () => {
                      setImplementing(true)
                      try {
                        await transferProjectDraft(projectId!, retryTask)
                        setPendingTransfer(undefined)
                        setHandoffResult({ key: handoffKey, error: '' })
                        useStore.getState().setActiveTask(retryTask)
                      } catch (e) {
                        setHandoffResult({ key: handoffKey, error: String(e) })
                      } finally {
                        setImplementing(false)
                      }
                    }}
                  >
                    Retry transfer to worktree
                  </button>
                ) : (
                  <p className="hint">Create a worktree to build this project draft.</p>
                )
              ) : (
                <button disabled={implementing || proposalBusy} onClick={() => void implement()}>
                  {implementing ? implementLabel : `Implement in ${taskTitle ?? 'main worktree'} →`}
                </button>
              )}
            </div>
            {handoffError && (
              <p className="hint file-tree-error" role="alert">
                {handoffError}
              </p>
            )}
            <div className="hint">
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
                  disabled={proposalBusy || task === PROJECT_DRAFT}
                  onClick={() => void applyProposal()}
                >
                  {proposalBusy ? 'Applying…' : 'Apply selection'}
                </button>
                <p className="hint">
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
              <div className="hint">
                {task === PROJECT_DRAFT
                  ? 'Project draft — includes any unassigned legacy shared plan. Transferred when you create a worktree.'
                  : 'Belongs to this worktree.'}
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
                <span className="hint">
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
                const tabSid = plannerSessionId(t.id, project?.id, task)
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
                  kind={active.kind}
                  componentId={PLAN_SCOPE}
                  terminalId={active.id}
                  sid={sid}
                  session={session}
                  task={task}
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
            <TerminalPane key={sid} componentId={PLAN_SCOPE} terminal={active} task={task} />
          </div>
        </div>
      </Panel>
    </PersistedGroup>
  )
}
