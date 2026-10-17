import { shallow } from 'zustand/shallow'
import { projectOf, projectStateOf, useStore } from '../store'
import {
  AGENT_ROLES,
  PLAN_SCOPE,
  TASK_ROOT_SCOPE,
  REVIEW_SCOPE,
  MERGE_SCOPE,
  TERMINAL_RUNNING,
  plannerSessionId,
  type AgentRole,
  type AutoBrief,
  type AutoLaunch,
  type AutoRun,
  type AutoStage,
  type EffortSettings,
  type Severity,
  type ReviewFindings,
  type MergeOutcome,
  type ActionReport,
  type Worktree,
  type SessionRecord,
  type SessionState,
} from '../types'
import {
  agentHooksCheck,
  agentProvider,
  gitBranches,
  gitReview,
  gitWorktrees,
  mergeOutcome,
  planRead,
  proposalRead,
  reviewRead,
  terminalSnapshot,
  terminalStop,
  graphValidationCancel,
} from './ipc'
import { graphActionIn } from './actions'
import { agentDevices } from './plan'
import { implementPlannerPlan } from './planHandoff'
import { refreshTasks } from './tasks'
import { fixReviewFindings } from './reviewHandoff'
import {
  DEFAULT_BRANCHES,
  defaultReviewBase,
  reviewBaseInputs,
  reviewState,
  startMergeAgent,
  startReviewAgents,
} from './reviewAgents'
import { reconcileFreshSessions, startTerminal } from './sessions'

import {
  EFFORT,
  integrated,
  SEVERITIES,
  taskPassed,
  unfinished,
  validOverrides,
} from './autoSettings'
import { fnv1a } from './hash'
import { autoRuns, autoWorkspace } from './autoState'
export { EFFORT, STAGES, STAGE_LABELS } from './autoSettings'

export function effortSettings(run: Pick<AutoRun, 'effort' | 'overrides'>): EffortSettings {
  return { ...EFFORT[run.effort], ...run.overrides }
}
export function blockingCount(findings: ReviewFindings | null, floor: Severity) {
  return SEVERITIES.slice(0, SEVERITIES.indexOf(floor) + 1).reduce(
    (sum, s) => sum + (findings?.verdict?.counts[s] ?? 0),
    0,
  )
}
/** A validation report with a task that didn't pass; components without a check are skipped. */
export const validationFailed = (report: ActionReport) => report.results.some((r) => !taskPassed(r))
/** One finding per failed validation terminal, for the fix agent's briefing. */
export function validationFailures(reports: ActionReport[], name: (sessionId: string) => string) {
  return reports
    .flatMap((report) =>
      report.results
        .filter((r) => !taskPassed(r))
        .map(
          (r) =>
            `[high] Validation failed: ${name(r.sessionId)} ${r.outcome}${r.exitCode === null ? '' : ` (exit ${r.exitCode})`}${r.message ? `: ${r.message}` : ''}`,
        ),
    )
    .join('\n')
}
export interface AutoSnapshot {
  plan: string
  proposal: boolean
  /** Fingerprint of the project plan and proposal, to tell whether a planner wrote new ones. */
  planMark: string
  goal: string
  source: Worktree
  worktrees: Worktree[]
  base: string
  changedComponents: string[]
  hasChanges: boolean
  findings: ReviewFindings | null
  freshness: 'none' | 'current' | 'stale'
  outcome: MergeOutcome
  agents: { sessionId: string; stage: AutoStage; state: string; sinceMs: number }[]
  reviewRecord?: SessionRecord
}
export type Decision = {
  stage: AutoStage
  status: AutoRun['status']
  reason: string
  sessionId?: string
  turnSince?: number
  observedWorking?: boolean
  waitingFor?: AutoRun['waitingFor']
}
export function reviewDecision(run: AutoRun, findings: ReviewFindings | null): Decision {
  // Issues without a single counted finding can't be weighed against the severity floor.
  if (
    !findings?.verdict ||
    findings.truncated ||
    (!findings.verdict.clean && Object.values(findings.verdict.counts).every((n) => n === 0))
  )
    return {
      stage: 'review',
      status: 'paused',
      reason: "Couldn't read the review verdict — open findings",
    }
  const count = blockingCount(findings, effortSettings(run).severityFloor)
  if (count > 0 || run.validationFindings) {
    if (run.round >= effortSettings(run).maxRounds)
      return {
        stage: 'fix',
        status: 'waitingOnYou',
        waitingFor: 'fixBudget',
        reason: `Fix budget exhausted (${run.round} rounds). ${count} blocking finding(s) remain.${run.validationFindings ? ' Validation still needs attention.' : ''}`,
      }
    return {
      stage: 'fix',
      status: 'running',
      reason: `${count} blocking finding(s)${run.validationFindings ? '; validation needs attention' : ''}`,
    }
  }
  return { stage: 'mergeGate', status: 'running', reason: 'No blocking findings remain' }
}
/**
 * Existing manual work takes precedence over a remembered stage. A `fresh` run (just started, with
 * its own goal) treats a branch whose earlier work is already merged as a new start, not as done.
 */
export function inferStage(snapshot: AutoSnapshot, run: AutoRun, fresh = false): Decision {
  const busy = snapshot.agents.find((a) => a.state === 'working' || a.state === 'needsInput')
  if (busy)
    return {
      stage: busy.stage,
      status: busy.state === 'needsInput' ? 'waitingOnYou' : 'running',
      reason: busy.state === 'needsInput' ? 'Agent needs input' : 'Waiting for the current agent',
      sessionId: busy.sessionId,
      turnSince: busy.sinceMs,
      observedWorking: busy.state === 'working',
      waitingFor: busy.state === 'needsInput' ? 'agentInput' : undefined,
    }
  if (run.stage === 'plan' && !fresh) {
    // A planner that answered after Auto paused may have saved its plan since.
    if (
      run.planMark !== undefined &&
      snapshot.planMark !== run.planMark &&
      (snapshot.plan.trim() || snapshot.proposal)
    )
      return { stage: 'implement', status: 'running', reason: 'Planner saved a new plan' }
    // Otherwise keep waiting on the run's own planner, at its prompt, for its next turn.
    const planner = snapshot.agents.find((a) => a.sessionId === run.sessionId && a.stage === 'plan')
    if (planner)
      return {
        stage: 'plan',
        status: 'running',
        reason: "Waiting for the planner's next turn",
        sessionId: planner.sessionId,
        turnSince: planner.sinceMs,
      }
  }
  if (integrated(snapshot.outcome)) {
    // A new goal on merged work: a fresh run, or one still planning or implementing it, starts
    // over; findings of the merged work don't apply to it.
    const startingOver =
      !snapshot.hasChanges && (fresh || run.stage === 'plan' || run.stage === 'implement')
    if (!startingOver) return { stage: 'done', status: 'done', reason: 'Branch is integrated' }
    if (run.stage === 'implement' && (snapshot.plan.trim() || snapshot.proposal))
      return { stage: 'implement', status: 'running', reason: 'Saved plan is ready' }
    return { stage: 'plan', status: 'running', reason: 'Earlier work is merged; plan the new goal' }
  }
  if (snapshot.freshness === 'current') return reviewDecision(run, snapshot.findings)
  if (snapshot.hasChanges)
    return {
      stage: effortSettings(run).validate || run.validationFindings ? 'validate' : 'review',
      status: 'running',
      reason: `Findings are ${snapshot.freshness}`,
    }
  if (run.stage === 'implement' && (snapshot.plan.trim() || snapshot.proposal))
    return { stage: 'implement', status: 'running', reason: 'Saved plan is ready' }
  return { stage: 'plan', status: 'running', reason: 'Describe the task to plan' }
}
export function nextStep(
  run: AutoRun,
  findings: ReviewFindings | null = null,
  outcome?: MergeOutcome,
): Decision {
  const step = (stage: AutoStage, reason: string): Decision => ({
    stage,
    status: 'running',
    reason,
  })
  switch (run.stage) {
    case 'plan':
      return step('implement', 'Plan finished')
    case 'implement':
    case 'fix':
      // Only a passing validation (or skipping it) settles failures, whatever the effort.
      return step(
        effortSettings(run).validate || run.validationFindings ? 'validate' : 'review',
        'Work finished; review again',
      )
    case 'validate':
      return step('review', 'Validation finished')
    case 'review':
      return reviewDecision(run, findings)
    case 'mergeGate':
      // Automatic merge covers only a branch Auto saw reviewed.
      return run.merge.mode === 'ask' || !run.reviewedHead
        ? {
            stage: 'mergeGate',
            status: 'waitingOnYou',
            reason: 'Ready to merge — approval required',
          }
        : step('merge', 'Merging automatically')
    case 'merge':
      return integrated(outcome)
        ? { stage: 'done', status: 'done', reason: 'Branch is integrated' }
        : {
            stage: 'merge',
            status: 'waitingOnYou',
            reason: `Merge did not complete (${outcome ?? 'unknown'})`,
            waitingFor: 'agentInput',
          }
    case 'done':
      return { stage: 'done', status: 'done', reason: 'Finished' }
  }
}
/**
 * The HEAD Auto may merge without asking: only one whose current findings leave nothing to fix at
 * this run's severity floor, with validation passing.
 */
export function mergeableHead(snapshot: AutoSnapshot, run: AutoRun) {
  return snapshot.freshness === 'current' &&
    reviewDecision(run, snapshot.findings).stage === 'mergeGate'
    ? snapshot.source.head
    : undefined
}
export function inferredGoal(plan: string, title: string, notes: string, branch: string) {
  return (
    plan.match(/^#+\s+(.+)$/m)?.[1]?.trim() ||
    plan
      .trim()
      .split(/\n\s*\n/)[0]
      ?.trim() ||
    [title, notes].filter(Boolean).join('\n\n') ||
    branch
  )
}

/** Enough to notice a rewritten plan without persisting its text. */
const fingerprint = (text: string) => `${text.length}:${fnv1a(text).toString(16)}`

function workspace(projectId: string, task: string | null) {
  return autoWorkspace(projectStateOf(projectId), task)
}
export const autoRun = (projectId: string, task: string | null) => workspace(projectId, task)?.auto
function patch(projectId: string, task: string | null, update: Partial<AutoRun>, text?: string) {
  const run = autoRun(projectId, task)
  if (!run) return
  useStore.getState().patchTask(projectId, task, {
    auto: {
      ...run,
      waitingFor: undefined,
      inputSessionId: undefined,
      // Only the approval wait reports these, again on its next poll.
      gateError: undefined,
      ...update,
      log: text ? [...run.log, { atMs: Date.now(), text }].slice(-100) : run.log,
    },
  })
}
function active(projectId: string, task: string | null) {
  const s = useStore.getState()
  return s.project?.id === projectId && s.activeTask === task
}
function mergeRequest(snapshot: Pick<AutoSnapshot, 'source' | 'worktrees'>, run: AutoRun) {
  const destination = snapshot.worktrees.find((w) => w.branch === run.merge.destinationBranch)
  if (!destination || destination.path === snapshot.source.path)
    throw new Error('Choose a different destination branch with an existing worktree')
  return {
    source: snapshot.source.path,
    sourceBranch: snapshot.source.branch!,
    destination: destination.path,
    destinationBranch: run.merge.destinationBranch,
  }
}
/** The run's worktree no longer has the run's branch checked out. */
export class BranchMoved extends Error {}
/** The worktree's `branch` has nothing to review against, such as `main` in the project folder. */
export class NoReviewBase extends Error {
  readonly task: string | null
  readonly path: string
  readonly branch: string
  readonly branches: string[]
  /** What the base was judged from (`reviewBaseInputs`). */
  readonly inputs: string
  constructor(task: string | null, source: Worktree, branches: string[], inputs: string) {
    super('No review base found; choose another worktree')
    this.task = task
    this.path = source.path
    this.branch = source.branch ?? ''
    this.branches = branches
    this.inputs = inputs
  }
}
/**
 * Whether a new worktree would give the run a base: only for the project folder on its default
 * (or only) branch, since other worktrees and branches can choose another one.
 */
export const wantsNewWorktree = (e: NoReviewBase) =>
  !e.task && (e.branches.length <= 1 || DEFAULT_BRANCHES.includes(e.branch))
/**
 * Whether what `e` was judged from, the worktree's checked-out branch, its task's base, the open
 * worktree's branch and the branches, has changed: two Git reads instead of a whole `autoSnapshot`.
 */
export async function reviewBaseMoved(projectId: string, e: NoReviewBase) {
  const [worktrees, branches] = await Promise.all([gitWorktrees(projectId), gitBranches(projectId)])
  const source = worktrees.find((w) => (e.task ? w.path === e.path : w.current))
  const tasks = projectStateOf(projectId)?.tasks ?? []
  return !source || reviewBaseInputs(source, tasks, worktrees, branches) !== e.inputs
}
/**
 * The run's worktree: a task's own, else the project folder's current worktree, whose top can sit
 * above a project in a subfolder. A run that recorded its `branch` never judges another branch
 * checked out there.
 */
async function sourceWorktree(
  projectId: string,
  task: string | null,
  worktrees: Worktree[],
  branch?: string,
) {
  // The task list loads after a restored layout, so a run resumed early loads it first.
  if (task && !projectStateOf(projectId)?.tasks.some((t) => t.id === task))
    await refreshTasks(projectId)
  const tasks = projectStateOf(projectId)?.tasks ?? []
  const path = task
    ? tasks.find((t) => t.id === task)?.worktree
    : worktrees.find((w) => w.current)?.path
  const source = worktrees.find((w) => w.path === path)
  if (!path || !source?.branch) throw new Error('Choose a worktree with a branch')
  if (branch && source.branch !== branch)
    throw new BranchMoved(
      `The worktree has ${source.branch} checked out, not this run's ${branch}; check ${branch} out again or Stop`,
    )
  return { source: { ...source, branch: source.branch }, tasks }
}
/**
 * Pinned read calls; no active-tab state is consulted after capturing the project. The merge
 * outcome scans both worktrees, so it is read only while merging or when `inferring` the stage of
 * a reviewed or merged branch; otherwise it stays `notMerged`.
 */
export async function autoSnapshot(
  projectId: string,
  task: string | null,
  run: AutoRun,
  inferring = false,
): Promise<AutoSnapshot> {
  const state = projectStateOf(projectId)
  const project = projectOf(projectId)
  if (!state?.project || !project) throw new Error('Open the project first')
  const plannerPlanPromise = planRead(projectId)
  const [worktrees, branches, saved, proposal, plannerPlan] = await Promise.all([
    gitWorktrees(projectId),
    gitBranches(projectId),
    task ? planRead(projectId, task) : plannerPlanPromise,
    proposalRead(projectId),
    plannerPlanPromise,
  ])
  const { source, tasks } = await sourceWorktree(projectId, task, worktrees, run.branch)
  const path = source.path
  // Review what the merge will bring in: the destination when it is a branch, else the default.
  const destination = run.merge.destinationBranch
  const base =
    destination && destination !== source.branch && branches.includes(destination)
      ? destination
      : defaultReviewBase(source, tasks, worktrees, branches)
  if (!base)
    throw new NoReviewBase(
      task,
      source,
      branches,
      reviewBaseInputs(source, tasks, worktrees, branches),
    )
  const [review, findings] = await Promise.all([
    gitReview(project, path, base),
    reviewRead(projectId, source.branch),
  ])
  const records = useStore
    .getState()
    .sessionRecords.filter((r) => r.metadata.projectId === projectId)
  const relevant = records.filter(
    (r) =>
      (r.metadata.kind === 'agent' &&
        !r.metadata.extensionId &&
        !r.metadata.commandId &&
        (r.metadata.task ?? null) === task &&
        (r.metadata.componentId === TASK_ROOT_SCOPE ||
          project.components.some((c) => c.id === r.metadata.componentId))) ||
      (r.spec.cwd === path && r.metadata.componentId === REVIEW_SCOPE) ||
      // The planner is project-wide: it belongs to this run only while it plans or tracks it.
      (r.metadata.componentId === PLAN_SCOPE &&
        (r.id === run.sessionId || (run.stage === 'plan' && !run.sessionId))) ||
      (r.metadata.componentId === MERGE_SCOPE && r.spec.merge_source === path),
  )
  const agents = relevant.flatMap((r) => {
    const session = useStore.getState().sessions[r.id]
    if (!(session?.running ?? r.snapshot?.running)) return []
    const status = session?.status ?? r.snapshot?.status
    const a = status?.agent
    const stage: AutoStage =
      r.metadata.componentId === PLAN_SCOPE
        ? 'plan'
        : r.metadata.componentId === REVIEW_SCOPE
          ? 'review'
          : r.metadata.componentId === MERGE_SCOPE
            ? 'merge'
            : run.stage === 'fix'
              ? 'fix'
              : 'implement'
    return [
      {
        sessionId: r.id,
        stage,
        state: status?.stopped ? 'idle' : (a?.state ?? (status?.active ? 'working' : 'idle')),
        sinceMs: a?.sinceMs ?? session?.startedMs ?? r.snapshot?.startedMs ?? Date.now(),
      },
    ]
  })
  const snapshot: AutoSnapshot = {
    // Implement hands off the project plan only, never an older worktree plan.
    plan: plannerPlan.text,
    proposal: !!proposal,
    planMark: fingerprint(JSON.stringify([plannerPlan.text, proposal])),
    // A task's goal is its own: the project plan may be left over from earlier work.
    goal: inferredGoal(
      task ? saved.text : plannerPlan.text,
      tasks.find((t) => t.id === task)?.title ?? '',
      tasks.find((t) => t.id === task)?.notes ?? '',
      source.branch,
    ),
    source,
    worktrees,
    base,
    changedComponents: Object.keys(review.changes).filter(
      (id) => review.changes[id].length > 0 && project.components.some((c) => c.id === id),
    ),
    hasChanges: !!review.ahead || Object.values(review.changes).some((files) => files.length > 0),
    findings,
    freshness: findings && findings.base !== base ? 'stale' : reviewState(findings, source),
    outcome: 'notMerged',
    agents,
    reviewRecord: records
      .filter((r) => r.metadata.componentId === REVIEW_SCOPE && r.spec.cwd === path)
      .sort((a, b) => (b.snapshot?.startedMs ?? 0) - (a.snapshot?.startedMs ?? 0))[0],
  }
  // A branch with no work yet is trivially "integrated", so inference reads the outcome only once
  // the branch was reviewed or merged. At the gate, also notice a merge done by hand.
  if (
    (run.stage === 'merge' ||
      run.stage === 'mergeGate' ||
      (inferring &&
        (findings ||
          records.some(
            (r) => r.metadata.componentId === MERGE_SCOPE && r.spec.merge_source === path,
          )))) &&
    run.merge.destinationBranch &&
    snapshot.worktrees.some(
      (w) => w.branch === run.merge.destinationBranch && w.path !== source.path,
    )
  )
    snapshot.outcome = await mergeOutcome(project, mergeRequest(snapshot, run))
  return snapshot
}
export type AutoSettings = Pick<
  AutoRun,
  'goal' | 'effort' | 'overrides' | 'merge' | 'device' | 'agents' | 'reviewers'
> & {
  stage?: AutoStage
}
/** The preset `stage` launches: its own, else the run's single preset. */
export const agentFor = (run: Pick<AutoRun, 'device' | 'agents'>, stage: AgentRole) =>
  run.agents?.[stage] || run.device
/** The presets of the review stage: several reviewing together, else the review agent. */
export const reviewAgents = (run: Pick<AutoRun, 'device' | 'agents' | 'reviewers'>) =>
  run.reviewers && run.reviewers.length > 1 ? run.reviewers : [agentFor(run, 'review')]
/** Every preset a run may launch, each once. */
export const runAgents = (run: Pick<AutoRun, 'device' | 'agents' | 'reviewers'>) => [
  ...new Set([...AGENT_ROLES.map((stage) => agentFor(run, stage)), ...reviewAgents(run)]),
]
const agentStage = (stage: AutoStage): stage is AgentRole =>
  (AGENT_ROLES as string[]).includes(stage)
export async function checkAutoHooks(deviceId: string) {
  const device = agentDevices(useStore.getState().devices).find((d) => d.id === deviceId)
  const provider = device ? await agentProvider(device) : null
  if (!provider) throw new Error('Choose an agent preset with Claude or Codex status integration')
  const hooks = await agentHooksCheck(provider)
  if (!hooks.installed || hooks.disabled || !hooks.reporterAvailable)
    throw new Error('Install Agent status integration before starting Auto mode')
}
/** One owner for each worktree's in-flight work and polling state. */
interface AutoController {
  projectId: string
  task: string | null
  phase: 'idle' | 'driving' | 'launching'
  /** Start runs beside a stale drive of a stopped run, which acts only on its own runId. */
  starting: boolean
  pending: boolean
  wake?: () => void
  validating: boolean
  gatePoll?: { runId: string; atMs: number }
  completionPoll?: { turn: string; atMs: number }
  gateRequest?: { key: string; request: ReturnType<typeof mergeRequest> }
}
const controllers = new Map<string, AutoController>()
/** The worktree's controller, if it has one; checks never create one. */
const peekController = (projectId: string, task: string | null) =>
  controllers.get(JSON.stringify([projectId, task]))
function controllerFor(projectId: string, task: string | null) {
  const key = JSON.stringify([projectId, task])
  let controller = controllers.get(key)
  if (!controller) {
    controller = {
      projectId,
      task,
      phase: 'idle',
      starting: false,
      pending: false,
      validating: false,
    }
    controllers.set(key, controller)
  }
  return controller
}
function release(controller: AutoController) {
  controller.phase = 'idle'
  if (controller.starting) return
  if (controller.pending) {
    controller.wake?.()
    return
  }
  // A worktree without an unfinished run keeps no state worth polling; drop its controller.
  const { projectId, task } = controller
  const key = JSON.stringify([projectId, task])
  if (
    !controller.validating &&
    !unfinished(autoRun(projectId, task)?.status) &&
    controllers.get(key) === controller
  )
    controllers.delete(key)
}
export async function startAuto(projectId: string, task: string | null, settings: AutoSettings) {
  const controller = controllerFor(projectId, task)
  if (controller.starting) throw new Error('Auto is already starting in this worktree')
  // A launch may still attach its agent to a run; any other drive belongs to a finished run.
  if (controller.phase === 'launching')
    throw new Error('Auto is still starting an agent; Start once it has started')
  controller.starting = true
  try {
    if (unfinished(autoRun(projectId, task)?.status))
      throw new Error('This worktree already has an Auto run')
    if (!validOverrides(settings.overrides ?? {}))
      throw new Error('Invalid Advanced effort settings')
    await Promise.all(runAgents(settings).map(checkAutoHooks))
    const run: AutoRun = {
      ...settings,
      runId: crypto.randomUUID(),
      stage: 'plan',
      status: 'running',
      round: 0,
      log: [],
    }
    const snapshot = await autoSnapshot(projectId, task, run, true)
    const decision = inferStage(snapshot, run, true)
    const stage =
      settings.stage === 'merge' && !mergeableHead(snapshot, run) ? 'mergeGate' : settings.stage
    assertSessionAvailable(projectId, task, decision.sessionId)
    // Merged work's old plan is no goal for a new run.
    if (
      (settings.stage ?? decision.stage) === 'plan' &&
      integrated(snapshot.outcome) &&
      !run.goal.trim()
    )
      throw new Error("This branch's earlier work is merged; describe the new goal")
    if (settings.stage && decision.sessionId)
      throw new Error('Finish or stop the current agent before overriding its stage')
    if (!run.goal.trim()) run.goal = snapshot.goal
    if ((settings.stage ?? decision.stage) === 'plan' && !run.goal.trim())
      throw new Error('Describe the task first')
    if (!active(projectId, task)) throw new Error('The task changed')
    const reviewedHead = mergeableHead(snapshot, run)
    // Starting at Merge skips the gate, so a branch not reviewed clean still waits for approval.
    useStore.getState().patchTask(projectId, task, {
      auto: {
        ...run,
        ...decision,
        branch: snapshot.source.branch,
        sessionStartedMs: decision.sessionId ? startedOf(decision.sessionId) : undefined,
        reviewedHead,
        findingsSummary:
          snapshot.freshness === 'current' ? snapshot.findings?.text.slice(0, 2000) : undefined,
        // An adopted planner must still save a plan other than the one it started with.
        planMark: decision.stage === 'plan' ? snapshot.planMark : undefined,
        ...(stage ? { stage, status: 'running' as const } : {}),
        log: [{ atMs: Date.now(), text: decision.reason }],
      },
    })
  } finally {
    controller.starting = false
    // A drive still running releases the controller itself when it ends.
    if (controller.phase === 'idle') release(controller)
  }
}
export function pauseAuto(projectId: string, task: string | null, reason = 'Paused by you') {
  patch(projectId, task, { status: 'paused', reason }, reason)
}
export async function resumeAuto(projectId: string, task: string | null) {
  const run = autoRun(projectId, task)
  if (!run) return
  // Resume changes the run id, so let a pending launch attach its session first.
  if (peekController(projectId, task)?.phase === 'launching')
    throw new Error('Auto is still starting an agent; Resume once it has started')
  // Tracked sessions are judged from the service's records; while it is away, nothing is known.
  if (run.sessionId && !useStore.getState().serviceConnected)
    throw new Error('Wait for the session service to reconnect, then Resume')
  const snapshot = await autoSnapshot(projectId, task, run, true)
  if (peekController(projectId, task)?.phase === 'launching')
    throw new Error('Auto is still starting an agent; Resume once it has started')
  // Pause preserves runId; a new status or another Pause still cancels this Resume.
  if (autoRun(projectId, task) !== run) return
  // A review round that can still finish keeps its reviewers that still work, including ones at an
  // interactive prompt; one that stopped after writing its findings is done. A broken round ends
  // instead: its reviewers stop and the stage is inferred again, so it reviews anew. A superseded
  // round stops only what Auto owns; sessions of the newer review stay, and inference follows it.
  const reviewers = run.stage === 'review' ? observe(run) : []
  const round = reviewers.length ? roundStatus(run, reviewers, snapshot.findings) : undefined
  const restart = round?.status === 'broken' || round?.status === 'superseded'
  const kept = restart ? [] : reviewers.filter((r) => !r.failed)
  const ending = reviewers.filter((r) => !kept.includes(r)).map((r) => r.sessionId)
  const superseded = round?.status === 'superseded'
  const ignored = superseded ? ending.filter((id) => ownsSession(run, id)) : ending
  const decision: Decision = kept.length
    ? {
        stage: 'review',
        status: 'running',
        reason: 'Checking reviewers',
        sessionId: kept[0].sessionId,
        turnSince: kept[0].turnSince,
        observedWorking: kept[0].observedWorking,
      }
    : inferStage(
        { ...snapshot, agents: snapshot.agents.filter((a) => !ignored.includes(a.sessionId)) },
        run,
      )
  if (decision.stage === 'review') await Promise.all(reviewAgents(run).map(checkAutoHooks))
  else if (agentStage(decision.stage)) await checkAutoHooks(agentFor(run, decision.stage))
  if (peekController(projectId, task)?.phase === 'launching')
    throw new Error('Auto is still starting an agent; Resume once it has started')
  if (autoRun(projectId, task) !== run) return
  assertSessionAvailable(projectId, task, decision.sessionId)
  // Ownership is checked again as each one stops: a tile restarted by hand meanwhile keeps running.
  const gone = await stopOwned(run, ending)
  if (autoRun(projectId, task) !== run) return
  const left = reviewers.filter((r) => restart && !superseded && !gone.includes(r.sessionId))
  if (left.length)
    throw new Error(
      `Close ${left.map((r) => r.name).join(', ')}, which Auto can't tell it started, then Resume`,
    )
  patch(
    projectId,
    task,
    {
      ...decision,
      ...track(kept.length ? kept : decision.sessionId ? [launchFor(run, decision.sessionId)] : []),
      reviewRound: kept.length ? run.reviewRound : undefined,
      // A run restored from before branches were recorded adopts its worktree's.
      branch: run.branch ?? snapshot.source.branch,
      reviewedHead: mergeableHead(snapshot, run),
      findingsSummary:
        snapshot.freshness === 'current'
          ? snapshot.findings?.text.slice(0, 2000)
          : run.findingsSummary,
      runId: crypto.randomUUID(),
      launchAtMs: kept.length || decision.sessionId === run.sessionId ? run.launchAtMs : undefined,
      turnSince: decision.turnSince,
      observedWorking: decision.observedWorking ?? false,
    },
    `Resumed: ${
      superseded
        ? "a newer review replaced Auto's round; "
        : restart
          ? 'the review round ended early; '
          : ''
    }${decision.reason}`,
  )
}
/** The launch request that started a session's current generation: the last its record lists. */
const latestRequest = (sid: string) =>
  useStore
    .getState()
    .sessionRecords.find((r) => r.id === sid)
    ?.requestIds?.at(-1)
type Tracked = AutoLaunch & { owned: boolean }
/** The sessions the run tracks, the primary first, then the reviewers beside it. */
function launches(run: AutoRun): Tracked[] {
  if (!run.sessionId) return []
  return [
    {
      sessionId: run.sessionId,
      startedMs: run.sessionStartedMs,
      requestId: run.sessionRequestId,
      lane: run.sessionLane,
      turnSince: run.turnSince,
      observedWorking: run.observedWorking,
      owned: !!run.sessionOwned,
    },
    ...(run.laneSessions ?? []).map((lane) => ({ ...lane, owned: true })),
  ]
}
/** Track `launches`: the first leads as the run's session, the rest are reviewers beside it. */
function track(launches: (AutoLaunch & { owned?: boolean })[]): Partial<AutoRun> {
  const pick = (l: AutoLaunch): AutoLaunch => ({
    sessionId: l.sessionId,
    startedMs: l.startedMs,
    requestId: l.requestId,
    lane: l.lane,
    turnSince: l.turnSince,
    observedWorking: l.observedWorking,
  })
  const [lead, ...lanes] = launches
  return {
    sessionId: lead?.sessionId,
    // Owned only with a generation to check.
    sessionOwned:
      !!lead && lead.owned !== false && (lead.startedMs !== undefined || !!lead.requestId),
    sessionStartedMs: lead?.startedMs,
    sessionRequestId: lead?.requestId,
    sessionLane: lead?.lane,
    turnSince: lead?.turnSince,
    observedWorking: lead?.observedWorking,
    laneSessions: lanes.length ? lanes.map(pick) : undefined,
  }
}
/** The run's launch of `sid` while it still runs that generation, else `sid` adopted as found. */
function launchFor(run: AutoRun, sid: string): Tracked {
  const tracked = observe(run).find((r) => r.sessionId === sid && !r.relaunched)
  return tracked ?? { sessionId: sid, startedMs: startedOf(sid), owned: false }
}
function owns(launch: Tracked, observedStart: number | undefined) {
  if (!launch.owned) return false
  if (launch.startedMs !== undefined) return observedStart === launch.startedMs
  return !!launch.requestId && latestRequest(launch.sessionId) === launch.requestId
}
/**
 * Each session the run tracks as it is now: `failed` when it was forgotten, stopped, relaunched,
 * or exited or went idle before finishing its turn (idle counts once it was seen in a turn, or
 * while `waitingOn` it); `done` once it reported the end of its turn. `lane` comes from the run,
 * else (for runs from before lanes were recorded) from its session record.
 */
function observe(run: AutoRun, waitingOn?: string) {
  const state = useStore.getState()
  return launches(run).map((launch) => {
    const id = launch.sessionId
    const record = state.sessionRecords.find((r) => r.id === id)
    const snapshot = state.sessions[id] ?? record?.snapshot
    const agent = snapshot?.status?.agent
    const since = launch.turnSince ?? run.launchAtMs ?? run.turnSince ?? 0
    const latest = launch.requestId && latestRequest(id)
    const relaunched =
      launch.startedMs !== undefined
        ? snapshot?.startedMs !== undefined && snapshot.startedMs !== launch.startedMs
        : !!latest && latest !== launch.requestId
    const forgotten =
      !snapshot &&
      state.serviceConnected &&
      !record &&
      (run.launchAtMs === undefined || Date.now() - run.launchAtMs > 5000)
    const done = !!agent?.authoritative && agent.state === 'review' && agent.sinceMs > since
    const idled =
      !!agent &&
      ['idle', 'ended'].includes(agent.state) &&
      (launch.observedWorking || agent.state === 'ended' || id === waitingOn) &&
      agent.sinceMs >= since
    return {
      ...launch,
      lane:
        launch.lane !== undefined
          ? launch.lane
          : record
            ? (record.metadata.lane ?? null)
            : undefined,
      name: run.stage === 'review' ? (record?.metadata.name ?? `Reviewer ${id}`) : 'Agent',
      snapshot,
      agent,
      since,
      forgotten,
      relaunched,
      done,
      failed:
        forgotten ||
        !!snapshot?.status?.stopped ||
        relaunched ||
        (!done && !!snapshot && (!snapshot.running || idled)),
    }
  })
}
type Observed = ReturnType<typeof observe>[number]
function failureReason(run: AutoRun, r: Observed, waitingOn?: string) {
  if (r.sessionId === run.sessionId)
    return r.forgotten
      ? 'The tracked session was forgotten'
      : r.sessionId === waitingOn
        ? 'Agent stopped while waiting for input'
        : r.snapshot?.status?.stopped || r.relaunched
          ? 'The tracked session was stopped or relaunched by hand'
          : r.agent?.message || 'Agent stopped before finishing its turn'
  const why = r.forgotten
    ? 'session was forgotten'
    : r.sessionId === waitingOn
      ? 'stopped while waiting for input'
      : 'stopped or relaunched before finishing its turn'
  return `${r.name}: ${why}${r.agent?.message ? ': ' + r.agent.message : ''}. Resume to review again`
}
/**
 * Where Auto's review round stands, for the drive and Resume alike. `superseded` when the latest
 * round in the findings isn't the one Auto launched (someone started a newer review); `broken` when
 * a reviewer failed before writing its findings, or a launch Auto doesn't track was never confirmed;
 * `complete` once
 * every reviewer finished its turn or failed after writing; else `running`. Reviewers are matched
 * to the findings by lane.
 */
function roundStatus(
  run: AutoRun,
  reviewers: Observed[],
  findings: ReviewFindings | null,
  waitingOn?: string,
): { status: 'running' | 'complete' | 'broken' | 'superseded'; reason?: string } {
  if (findings && run.reviewRound !== undefined && findings.round !== run.reviewRound)
    return {
      status: 'superseded',
      reason: "A newer review replaced Auto's round; Resume to continue from it",
    }
  const wrote = (r: Observed) =>
    r.lane !== undefined &&
    !!findings?.reviewers.some((f) => f.finished && (f.lane ?? null) === r.lane)
  const failed = reviewers.find((r) => r.failed && !wrote(r))
  if (failed) return { status: 'broken', reason: failureReason(run, failed, waitingOn) }
  // A launch that may not have started, which Auto doesn't track (one it tracks is judged above).
  const unconfirmed =
    findings?.reviewers.filter(
      (f) => f.error && !f.finished && !reviewers.some((r) => r.lane === (f.lane ?? null)),
    ) ?? []
  if (unconfirmed.length)
    return {
      status: 'broken',
      reason: `${unconfirmed.map((f) => `${f.lane ?? 'Reviewer'} may not have started: ${f.error}`).join('; ')}. Resume to review again`,
    }
  return reviewers.every((r) => r.done || (r.failed && wrote(r)))
    ? { status: 'complete' }
    : { status: 'running' }
}
/** A session's start time, from its record when this window hasn't hydrated it yet. */
function startedOf(sid: string) {
  const s = useStore.getState()
  return (
    s.sessions[sid]?.startedMs ?? s.sessionRecords.find((r) => r.id === sid)?.snapshot?.startedMs
  )
}
function ownsSession(
  run: AutoRun,
  sessionId = run.sessionId,
  observedStart = sessionId ? startedOf(sessionId) : undefined,
) {
  const launch = sessionId ? launches(run).find((l) => l.sessionId === sessionId) : undefined
  return !!launch && owns(launch, observedStart)
}
/**
 * Stop the tracked `sessionIds` whose process generations still belong to this run. Resolves to
 * those known to be no longer running: stopped here, or already gone.
 */
async function stopOwned(run: AutoRun, sessionIds: string[]) {
  const gone: string[] = []
  const stopping = launches(run).filter((launch) => sessionIds.includes(launch.sessionId))
  // Ownership through a launch request reads the records: refresh them once, so a hand relaunch
  // is seen.
  if (stopping.some((launch) => launch.owned && launch.startedMs === undefined))
    await reconcileFreshSessions().catch(() => {})
  await Promise.all(
    stopping.map(async (launch) => {
      const id = launch.sessionId
      try {
        const state = useStore.getState()
        let session: Pick<SessionState, 'startedMs' | 'running' | 'status'> | null | undefined =
          state.sessions[id] ?? state.sessionRecords.find((r) => r.id === id)?.snapshot
        if (startedOf(id) === undefined) session = await terminalSnapshot(id)
        // One already being stopped needs no second stop.
        if (!session?.running || session.status?.stopped) gone.push(id)
        else if (owns(launch, session.startedMs)) {
          await terminalStop(id)
          gone.push(id)
        }
      } catch (e) {
        useStore.getState().setMessage(String(e))
      }
    }),
  )
  return gone
}
/** Stop every session the run tracks while its process generation still belongs to the run. */
const stopTracked = (run: AutoRun) =>
  stopOwned(
    run,
    launches(run).map((l) => l.sessionId),
  )
export function stopAuto(projectId: string, task: string | null) {
  const run = autoRun(projectId, task)
  patch(
    projectId,
    task,
    { runId: crypto.randomUUID(), status: 'stopped', reason: 'Stopped by you' },
    'Auto stopped',
  )
  if (run) void stopTracked(run)
  if (peekController(projectId, task)?.validating)
    void graphValidationCancel(projectId).catch((e) => useStore.getState().setMessage(String(e)))
}
export async function skipStage(projectId: string, task: string | null) {
  const run = autoRun(projectId, task)
  if (!run || run.status === 'running') return
  if (run.sessionId) {
    await stopTracked(run)
    if (
      autoRun(projectId, task)?.runId !== run.runId ||
      autoRun(projectId, task)?.status === 'running'
    )
      return
  }
  // Only an explicit budget wait accepts findings. Failed or interrupted fixes return to review.
  const stage: AutoStage =
    run.stage === 'plan'
      ? 'implement'
      : run.stage === 'implement' ||
          run.stage === 'validate' ||
          (run.stage === 'fix' && run.waitingFor !== 'fixBudget')
        ? 'review'
        : 'mergeGate'
  // Skipping review cannot grant automatic merge permission.
  patch(
    projectId,
    task,
    {
      runId: crypto.randomUUID(),
      ...track([]),
      reviewRound: undefined,
      inputSessionId: undefined,
      reviewedHead: stage === 'mergeGate' ? undefined : run.reviewedHead,
      // Skipped validation leaves no failures for review and fix to act on.
      ...(run.stage === 'validate' ? { validation: undefined, validationFindings: undefined } : {}),
      stage,
      status: stage === 'mergeGate' ? 'waitingOnYou' : 'running',
      reason: 'Stage skipped by you',
    },
    'Stage skipped by you',
  )
}
/** End a run whose branch is integrated, stopping a still running agent it launched and owns. */
function settleIntegrated(projectId: string, task: string | null, run: AutoRun) {
  patch(
    projectId,
    task,
    { stage: 'done', status: 'done', reason: 'Branch is integrated' },
    'Branch is integrated',
  )
  // The panel offers no Stop for a finished run, so its agents would be left running.
  void stopTracked(run)
}
export function mergeNow(projectId: string, task: string | null) {
  const run = autoRun(projectId, task)
  if (run?.stage !== 'mergeGate' || run.status !== 'waitingOnYou') return
  patch(projectId, task, { stage: 'merge', status: 'running', reason: undefined }, 'Merge approved')
}
function briefing(run: AutoRun): AutoBrief {
  return {
    goal: run.goal,
    fixFloor: run.stage === 'fix' ? effortSettings(run).severityFloor : null,
    effortNote:
      EFFORT[run.effort].note +
      (run.stage === 'fix' && run.validationFindings
        ? `\n\nValidation findings:\n${run.validationFindings}`
        : ''),
    commit: run.stage === 'implement' || run.stage === 'fix' || run.stage === 'merge',
  }
}
// Reserve a shared planner before awaiting its launch; records arrive only afterwards.
const launchingSessions = new Map<string, string>()
function assertSessionAvailable(projectId: string, task: string | null, sessionId?: string) {
  if (!sessionId) return
  const key = JSON.stringify([projectId, task])
  const reservation = launchingSessions.get(sessionId)
  const p = projectStateOf(projectId)
  if (
    (reservation && reservation !== key) ||
    (p &&
      autoRuns(p).some(
        ({ task: other, run: owner }) =>
          other !== task && owner.sessionId === sessionId && unfinished(owner.status),
      ))
  )
    throw new Error('This planner or agent already belongs to another Auto run')
}
/** Cache only the pinned merge request; outcome checks need no plans, findings or diff. */
async function approvalOutcome(
  projectId: string,
  task: string | null,
  run: AutoRun,
  controller: AutoController,
) {
  const project = projectOf(projectId)
  if (!project) throw new Error('Open the project first')
  const key = JSON.stringify([run.runId, run.merge.destinationBranch])
  if (controller.gateRequest?.key !== key) {
    const worktrees = await gitWorktrees(projectId)
    const { source } = await sourceWorktree(projectId, task, worktrees, run.branch)
    controller.gateRequest = { key, request: mergeRequest({ source, worktrees }, run) }
  }
  return mergeOutcome(project, controller.gateRequest.request)
}
async function drive(projectId: string, task: string | null) {
  const key = JSON.stringify([projectId, task])
  const controller = controllerFor(projectId, task)
  const initial = autoRun(projectId, task)
  if (!initial || !['running', 'waitingOnYou'].includes(initial.status)) return
  const runId = initial.runId
  const live = () => {
    const r = autoRun(projectId, task)
    return r?.runId === runId && r.status === 'running' ? r : null
  }
  // A tracked agent is followed through an input wait too; Pause or Stop still end this drive.
  const current = () => {
    const r = autoRun(projectId, task)
    return r?.runId === runId && (r.status === 'running' || r.status === 'waitingOnYou') ? r : null
  }
  let reservedSession: string | undefined
  try {
    let run = autoRun(projectId, task)!
    // Approval waits still observe Git, including a merge performed outside Auto.
    if (run.stage === 'mergeGate' && run.status === 'waitingOnYou' && !run.sessionId) {
      const previous = controller.gatePoll
      if (previous?.runId === runId && Date.now() - previous.atMs < 5000) return
      controller.gatePoll = { runId, atMs: Date.now() }
      let outcome: MergeOutcome
      try {
        outcome = await approvalOutcome(projectId, task, run, controller)
      } catch (e) {
        // Resolve worktrees again after a missing checkout or branch switch, and show the
        // failure beside the wait's own reason while retrying for temporary Git errors.
        controller.gateRequest = undefined
        const latest = autoRun(projectId, task)
        const gateError = e instanceof Error ? e.message : String(e)
        if (
          latest?.runId === runId &&
          latest.stage === 'mergeGate' &&
          latest.status === 'waitingOnYou' &&
          latest.gateError !== gateError
        )
          patch(
            projectId,
            task,
            { gateError, waitingFor: latest.waitingFor },
            `Couldn't check merge status: ${gateError}`,
          )
        return
      }
      const latest = autoRun(projectId, task)
      if (
        latest?.runId !== runId ||
        latest.stage !== 'mergeGate' ||
        latest.status !== 'waitingOnYou'
      )
        return
      if (integrated(outcome)) settleIntegrated(projectId, task, latest)
      else if (latest.gateError)
        patch(projectId, task, { gateError: undefined, waitingFor: latest.waitingFor })
      return
    }
    if (run.sessionId) {
      const state = useStore.getState()
      const session =
        state.sessions[run.sessionId] ??
        state.sessionRecords.find((r) => r.id === run.sessionId)?.snapshot
      // The session whose prompt the input wait opened: going idle there means it stopped.
      const waitingOn =
        run.status === 'waitingOnYou' ? (run.inputSessionId ?? run.sessionId) : undefined
      const reviewers = observe(run, waitingOn)
      const failed = reviewers.filter((r) => r.failed)
      const agent = session?.status?.agent
      // A merge agent that ended may have left the merge done: the user may have resolved and
      // committed it before closing the agent. True once this settled the run.
      const mergedByHand = async () => {
        if (run.stage !== 'merge') return false
        const current = run
        let outcome: MergeOutcome
        try {
          outcome = await approvalOutcome(projectId, task, current, controller)
        } catch (e) {
          controller.gateRequest = undefined
          if (autoRun(projectId, task) === current)
            pauseAuto(projectId, task, `Couldn't check merge status: ${e}`)
          return true
        }
        if (autoRun(projectId, task) !== current) return true
        if (!integrated(outcome)) return false
        settleIntegrated(projectId, task, current)
        return true
      }
      // Outside review, a failed agent pauses at once; a failed reviewer may have written first.
      if (failed.length && run.stage !== 'review') {
        if (await mergedByHand()) return
        pauseAuto(projectId, task, failureReason(run, failed[0], waitingOn))
        return
      }
      const input = failed.length
        ? undefined
        : reviewers.find((r) => r.agent?.authoritative && r.agent.state === 'needsInput')
      if (input) {
        const reason = `${input.name} needs input${input.agent?.message ? ': ' + input.agent.message : ''}`
        if (
          run.status !== 'waitingOnYou' ||
          run.inputSessionId !== input.sessionId ||
          run.reason !== reason
        )
          patch(
            projectId,
            task,
            {
              // A reviewer asking for input is in a turn: going idle afterwards is a stop.
              ...track(
                launches(run).map((l) =>
                  l.sessionId === input.sessionId ? { ...l, observedWorking: true } : l,
                ),
              ),
              status: 'waitingOnYou',
              waitingFor: 'agentInput',
              inputSessionId: input.sessionId,
              reason,
            },
            reason,
          )
        return
      }
      if (run.status === 'waitingOnYou' && !failed.length) {
        const resumed = reviewers.filter(
          (r) =>
            r.agent?.authoritative &&
            ['working', 'review'].includes(r.agent.state) &&
            r.agent.sinceMs > (run.turnSince ?? 0),
        )
        if (run.waitingFor !== 'agentInput' || !resumed.length) return
        patch(
          projectId,
          task,
          {
            // Only the reviewers that resumed were seen working.
            ...track(
              launches(run).map((l) =>
                resumed.some((r) => r.sessionId === l.sessionId)
                  ? { ...l, observedWorking: true }
                  : l,
              ),
            ),
            turnSince: run.turnSince,
            status: 'running',
            inputSessionId: undefined,
            reason: undefined,
          },
          'Agent resumed work',
        )
        run = live()!
      }
      const completedAt = Math.max(...reviewers.map((r) => r.agent?.sinceMs ?? 0))
      if (failed.length || reviewers.every((r) => r.done)) {
        const turn = JSON.stringify([
          run.runId,
          run.sessionId,
          completedAt,
          failed.map((r) => r.sessionId),
        ])
        const previous = controller.completionPoll
        if (previous?.turn === turn && Date.now() - previous.atMs < 5000) return
        controller.completionPoll = { turn, atMs: Date.now() }
        const snapshot = await autoSnapshot(projectId, task, run)
        if (!current()) return
        // The same judgement as Resume's: a newer or broken round pauses.
        const round =
          run.stage === 'review'
            ? roundStatus(run, reviewers, snapshot.findings, waitingOn)
            : undefined
        if (round?.status === 'broken' || round?.status === 'superseded') {
          pauseAuto(projectId, task, round.reason!)
          return
        }
        if (round?.status === 'running') {
          // Reviewers that stopped after writing their findings are done: stop tracking them.
          await stopOwned(
            run,
            failed.map((r) => r.sessionId),
          )
          const latest = current()
          if (!latest) return
          // An input wait on a reviewer still tracked stays open; one on a finished reviewer ends.
          const waiting = reviewers.some((r) => !r.failed && r.sessionId === latest.inputSessionId)
          patch(projectId, task, {
            ...track(reviewers.filter((r) => !r.failed)),
            ...(waiting
              ? { waitingFor: latest.waitingFor, inputSessionId: latest.inputSessionId }
              : { status: 'running' as const, reason: undefined }),
          })
          return
        }
        const tracking = new Set(reviewers.map((r) => r.sessionId))
        const otherAgents = snapshot.agents.filter((a) => !tracking.has(a.sessionId))
        const other = otherAgents.find(
          (a) => ['working', 'needsInput'].includes(a.state) && a.stage === run.stage,
        )
        const following = otherAgents.some((a) => ['working', 'needsInput'].includes(a.state))
        if (other) {
          controller.completionPoll = undefined
          const reason = 'Waiting for another agent in this worktree to finish'
          if (run.reason !== reason) patch(projectId, task, { reason }, reason)
          return
        }
        // Never advance on a previous attempt's saved findings.
        if (
          !following &&
          run.stage === 'review' &&
          (!snapshot.findings?.reviewedHead ||
            (run.launchAtMs !== undefined && snapshot.findings.startedMs < run.launchAtMs))
        ) {
          if (Date.now() - completedAt > 30000)
            pauseAuto(projectId, task, "Couldn't read the review verdict — open findings")
          return
        }
        // A plan saved before this planner launched is no answer to its goal.
        if (
          !following &&
          run.stage === 'plan' &&
          ((!snapshot.plan.trim() && !snapshot.proposal) ||
            (run.planMark !== undefined && snapshot.planMark === run.planMark))
        ) {
          pauseAuto(projectId, task, 'Planner finished without saving a new plan')
          return
        }
        const decision = following
          ? inferStage({ ...snapshot, agents: otherAgents }, run)
          : nextStep(run, snapshot.findings, snapshot.outcome)
        if (!following && run.stage === 'review' && snapshot.freshness !== 'current') {
          pauseAuto(
            projectId,
            task,
            'The branch changed during review; close the reviewers and Resume to review again',
          )
          return
        }
        assertSessionAvailable(projectId, task, decision.sessionId)
        const low = snapshot.findings?.verdict
          ? Object.values(snapshot.findings.verdict.counts).reduce((a, b) => a + b, 0) -
            blockingCount(snapshot.findings, effortSettings(run).severityFloor)
          : 0
        // An agent whose stage didn't finish (a merge that stopped on conflicts or failing checks,
        // an unreadable verdict) stays for the user to answer; one that finished is done.
        const finished = decision.stage !== run.stage
        // The planner Auto takes over is stopped too: it belongs to the project, not the run.
        if (finished && run.stage === 'plan' && session?.running && !ownsSession(run))
          await terminalStop(run.sessionId!)
        if (finished) await stopTracked(run)
        if (!current()) return
        patch(
          projectId,
          task,
          {
            ...decision,
            // A kept agent stays tracked, so Stop still ends it.
            ...(finished
              ? {
                  ...track(decision.sessionId ? [launchFor(run, decision.sessionId)] : []),
                  reviewRound: undefined,
                  inputSessionId: undefined,
                }
              : {}),
            launchAtMs: undefined,
            // Only the validation a finished fix leads to settles these failures; a skipped or
            // interrupted fix keeps them for review to act on.
            ...(run.stage === 'fix' && decision.stage === 'validate'
              ? { validationFindings: undefined }
              : {}),
            reason:
              run.stage === 'merge' && decision.status === 'waitingOnYou'
                ? `${decision.reason}${agent?.message ? ': ' + agent.message : ''}`
                : decision.reason,
            turnSince: decision.sessionId
              ? decision.turnSince
              : decision.waitingFor === 'agentInput'
                ? agent?.sinceMs
                : decision.turnSince,
            observedWorking: decision.observedWorking ?? false,
            reviewedHead: run.stage === 'review' ? mergeableHead(snapshot, run) : run.reviewedHead,
            findingsSummary:
              run.stage === 'review' ? snapshot.findings?.text.slice(0, 2000) : run.findingsSummary,
          },
          `${decision.reason}${low ? `; ${low} finding(s) below the severity floor remain` : ''}`,
        )
        return
      }
      controller.completionPoll = undefined
      const working = reviewers.filter((r) => r.agent?.state === 'working' && r.agent.authoritative)
      if (working.some((r) => !r.observedWorking || r.agent!.sinceMs > r.since))
        patch(
          projectId,
          task,
          track(
            reviewers.map((r) => {
              const turn = working.find((w) => w.sessionId === r.sessionId)?.agent?.sinceMs
              return turn === undefined
                ? r
                : { ...r, turnSince: Math.max(r.since, turn), observedWorking: true }
            }),
          ),
        )
      if (run.stage === 'review') {
        const reason = 'Waiting for reviewers to finish'
        if (run.reason !== reason) patch(projectId, task, { reason }, reason)
      }
      return
    }
    controller.completionPoll = undefined
    if (run.status !== 'running') return
    if (!active(projectId, task)) {
      pauseAuto(
        projectId,
        task,
        `Switch to ${projectStateOf(projectId)?.tasks.find((t) => t.id === task)?.title ?? 'the project folder'} to continue`,
      )
      return
    }
    const snapshot = await autoSnapshot(projectId, task, run)
    if (!live()) return
    if (!active(projectId, task)) {
      pauseAuto(projectId, task, 'Switch back to this worktree to continue')
      return
    }
    const project = projectOf(projectId)!
    if (!live()) return
    run = live()!
    if ((run.stage === 'mergeGate' || run.stage === 'merge') && integrated(snapshot.outcome)) {
      settleIntegrated(projectId, task, run)
      return
    }
    if (
      (run.stage === 'mergeGate' || run.stage === 'merge') &&
      run.reviewedHead &&
      (run.reviewedHead !== snapshot.source.head || snapshot.freshness !== 'current')
    ) {
      pauseAuto(projectId, task, 'The branch changed since review; Resume to review again')
      return
    }
    if (
      (run.stage === 'mergeGate' || run.stage === 'merge') &&
      run.reviewedHead &&
      mergeableHead(snapshot, run) !== run.reviewedHead
    ) {
      pauseAuto(
        projectId,
        task,
        'The review no longer permits automatic merging; Resume to review again',
      )
      return
    }
    if (run.stage === 'mergeGate') {
      patch(projectId, task, nextStep(run), nextStep(run).reason)
      return
    }
    if (run.stage === 'done') {
      patch(projectId, task, { status: 'done' }, 'Finished')
      return
    }
    if (run.stage === 'validate') {
      if (workspace(projectId, task)?.graphActionBusy) {
        pauseAuto(projectId, task, 'Another graph action is running')
        return
      }
      const reports: ActionReport[] = []
      controller.validating = true
      try {
        if (snapshot.changedComponents.length) {
          const request = {
            kind: 'validateChanged' as const,
            componentIds: snapshot.changedComponents,
          }
          reports.push(await graphActionIn(projectId, task, project, request))
        }
      } catch (e) {
        // Another worktree's action or an already running check clears up by itself; Resume retries.
        if (live()) pauseAuto(projectId, task, `Validation couldn't run: ${e}`)
        return
      } finally {
        controller.validating = false
      }
      if (!live()) return
      const records = useStore.getState().sessionRecords
      const failures = validationFailures(
        reports,
        (id) => records.find((r) => r.id === id)?.metadata.name ?? id,
      )
      patch(
        projectId,
        task,
        { ...nextStep(run), validation: reports, validationFindings: failures || undefined },
        failures
          ? 'Validation needs attention; passing results to review and fix'
          : 'Validation passed',
      )
      return
    }
    if (!agentStage(run.stage)) throw new Error(`Unsupported Auto stage ${run.stage}`)
    const deviceId = agentFor(run, run.stage)
    const presets = agentDevices(useStore.getState().devices)
    const device = presets.find((d) => d.id === deviceId)
    if (!device) throw new Error('The selected agent preset is unavailable')
    const reviewers =
      run.stage === 'review'
        ? reviewAgents(run).map((id) => {
            const reviewer = presets.find((d) => d.id === id)
            if (!reviewer) throw new Error('The selected agent preset is unavailable')
            return reviewer
          })
        : [device]
    await Promise.all(reviewers.map((d) => checkAutoHooks(d.id)))
    if (!live() || !active(projectId, task)) return
    // Guard against a manually launched competing agent.
    const competing = snapshot.agents.find((a) => a.state === 'working' || a.state === 'needsInput')
    if (competing) {
      pauseAuto(projectId, task, 'Another agent is active in this worktree')
      return
    }
    // A fixed review/merge slot may still contain a manual agent, even after its turn.
    const occupied = snapshot.agents.find(
      (a) =>
        (run.stage === 'review' && a.stage === 'review') ||
        (run.stage === 'merge' && a.stage === 'merge'),
    )
    if (occupied) {
      pauseAuto(projectId, task, 'Close the current agent before starting another in this slot')
      return
    }
    const since = Date.now()
    let sid: string
    let lanes: string[] = []
    // What the review stage launched, beyond session ids: one entry per session.
    let review: Pick<AutoLaunch, 'requestId' | 'lane'>[] = []
    let reviewRound: string | undefined
    let reviewErrors: string[] = []
    const brief = briefing(run)
    patch(
      projectId,
      task,
      {
        turnSince: since,
        launchAtMs: since,
        observedWorking: false,
        planMark: run.stage === 'plan' ? snapshot.planMark : run.planMark,
      },
      `Starting ${run.stage}${run.stage === 'fix' ? ` round ${run.round + 1}` : ''}`,
    )
    if (!live() || !active(projectId, task)) return
    controller.phase = 'launching'
    switch (run.stage) {
      case 'plan':
        sid = plannerSessionId(deviceId, projectId)
        assertSessionAvailable(projectId, task, sid)
        launchingSessions.set(sid, key)
        reservedSession = sid
        if (useStore.getState().sessions[sid]?.running) {
          pauseAuto(
            projectId,
            task,
            'Close the current planner before starting another in this slot',
          )
          return
        }
        if (!live() || !active(projectId, task)) return
        await startTerminal(PLAN_SCOPE, deviceId, task, projectId, {
          kickoff: { kind: 'plan' },
          auto: brief,
        })
        break
      case 'implement':
        // The planner whose plan is accepted is the plan stage's; the implement agent may differ.
        sid = await implementPlannerPlan(agentFor(run, 'plan'), brief, deviceId)
        break
      case 'review': {
        const started = await startReviewAgents(
          project,
          { worktree: snapshot.source.path, branch: snapshot.source.branch!, base: snapshot.base },
          reviewers,
          brief,
        )
        ;[sid, ...lanes] = started.started.map((r) => r.sessionId)
        review = started.started
        reviewRound = started.round
        reviewErrors = started.errors
        break
      }
      case 'fix':
        if (!snapshot.reviewRecord)
          throw new Error('Open findings and start a review before fixing')
        sid = await fixReviewFindings(snapshot.reviewRecord, brief, deviceId)
        // A refused launch rejects; one that returned may be running even if confirming it fails,
        // so it uses up its round now.
        if (sid && autoRun(projectId, task)?.runId === runId)
          patch(projectId, task, { round: run.round + 1 })
        break
      case 'merge':
        sid = await startMergeAgent(
          project,
          mergeRequest(snapshot, run),
          device,
          crypto.randomUUID(),
          brief,
        )
        break
      default:
        throw new Error(`Unsupported Auto stage ${run.stage}`)
    }
    if (!sid) throw new Error('Agent launch returned no session')
    if (run.stage !== 'review') await reconcileFreshSessions()
    if (
      run.stage !== 'review' &&
      !useStore.getState().sessions[sid] &&
      !useStore.getState().sessionRecords.some((r) => r.id === sid)
    )
      throw new Error('Agent launch was not confirmed; Resume to try again')
    const generations = await Promise.all(
      [sid, ...lanes].map(async (id) => ({
        sessionId: id,
        startedMs: startedOf(id) ?? (await terminalSnapshot(id).catch(() => null))?.startedMs,
      })),
    )
    const latest = autoRun(projectId, task)
    if (latest?.runId !== runId || latest.status === 'stopped' || latest.status === 'done') {
      await Promise.all([sid, ...lanes].map((id) => terminalStop(id)))
      return
    }
    patch(projectId, task, {
      // Owned with its start time, else its launch request, so a later session under this id
      // never is. The round and lanes tell Auto's reviewers' findings from anyone else's.
      ...track(generations.map((g, i) => ({ ...g, ...review[i], owned: true }))),
      reviewRound,
      sessionBrief: {
        sessionId: sid,
        auto: brief,
        kickoff: run.stage === 'plan' ? { kind: 'plan' } : undefined,
      },
      turnSince: since,
      ...(reviewErrors.length
        ? { status: 'paused', reason: `Some reviewers didn't start: ${reviewErrors.join('; ')}` }
        : {}),
    })
  } catch (e) {
    const latest = autoRun(projectId, task)
    if (
      latest?.runId === runId &&
      (latest.status === 'running' ||
        (latest.status === 'waitingOnYou' && latest.stage === 'mergeGate'))
    ) {
      // Checking the run's branch out again and resuming continues it.
      if (e instanceof BranchMoved) pauseAuto(projectId, task, e.message)
      // A session someone else started in the slot, perhaps one whose launch reply was lost.
      else if (String(e).includes(TERMINAL_RUNNING))
        pauseAuto(projectId, task, 'Close the current agent in this slot, then Resume')
      else patch(projectId, task, { status: 'failed', reason: String(e) }, String(e))
    }
  } finally {
    if (reservedSession && launchingSessions.get(reservedSession) === key)
      launchingSessions.delete(reservedSession)
  }
}
/** The main window owns a single driver; the timer also polls findings every five seconds. */
export function followAuto() {
  let queued = false
  let disposed = false
  const schedule = (projectId: string, task: string | null) => {
    if (disposed) return
    const controller = controllerFor(projectId, task)
    controller.wake = () => schedule(projectId, task)
    if (controller.phase !== 'idle' || controller.starting) {
      controller.pending = true
      return
    }
    controller.pending = false
    controller.phase = 'driving'
    void drive(projectId, task).finally(() => release(controller))
  }
  const tick = () => {
    if (queued || disposed) return
    queued = true
    queueMicrotask(() => {
      queued = false
      if (disposed || useStore.getState().restoring) return
      const state = useStore.getState()
      for (const id of state.projectOrder) {
        const p = projectStateOf(id)
        if (!p) continue
        for (const { task, run } of autoRuns(p)) {
          if (
            run &&
            (run.status === 'running' ||
              (run.status === 'waitingOnYou' &&
                (run.waitingFor === 'agentInput' || run.stage === 'mergeGate')))
          )
            schedule(id, task)
        }
      }
    })
  }
  // Output buffers change on every terminal line; only run and session lifecycle changes
  // need an immediate drive. The timer still polls Git and saved plans.
  const lifecycle = (
    session: Pick<SessionState, 'running' | 'startedMs' | 'status'> | null | undefined,
  ) => [
    session?.running,
    session?.startedMs,
    session?.status?.active,
    session?.status?.stopped,
    session?.status?.agent?.state,
    session?.status?.agent?.sinceMs,
    session?.status?.agent?.authoritative,
    session?.status?.agent?.message,
  ]
  const watch = (state: ReturnType<typeof useStore.getState>) => [
    state.restoring,
    state.serviceConnected,
    state.project?.id,
    ...state.projectOrder.flatMap((id) => {
      const p = projectStateOf(id, state)
      return p ? [id, p.activeTask, ...autoRuns(p).flatMap(({ task, run }) => [task, run])] : [id]
    }),
    ...Object.entries(state.sessions).flatMap(([id, session]) => [id, ...lifecycle(session)]),
    ...state.sessionRecords.flatMap((record) => [
      record.id,
      record.metadata.projectId,
      record.metadata.task,
      record.metadata.componentId,
      record.metadata.kind,
      record.metadata.extensionId,
      record.metadata.commandId,
      record.spec.cwd,
      record.spec.merge_source,
      ...lifecycle(record.snapshot ?? undefined),
    ]),
  ]
  // Most store updates (including output counters) leave these references untouched.
  // Select them first, before building lifecycle arrays across every session and record.
  const inputs = (state: ReturnType<typeof useStore.getState>) => [
    state.restoring,
    state.serviceConnected,
    state.project,
    state.projectOrder,
    state.projects,
    state.activeTask,
    state.auto,
    state.taskWorkspaces,
    state.sessions,
    state.sessionRecords,
  ]
  let watched = watch(useStore.getState())
  const unsubscribe = useStore.subscribe((state, previous) => {
    if (shallow(inputs(state), inputs(previous))) return
    const next = watch(state)
    const changed = !shallow(next, watched)
    watched = next
    if (changed) tick()
  })
  const interval = setInterval(tick, 5000)
  tick()
  return () => {
    disposed = true
    for (const [key, controller] of controllers) {
      controller.wake = undefined
      controller.pending = false
      if (controller.phase === 'idle' && !controller.starting) controllers.delete(key)
    }
    unsubscribe()
    clearInterval(interval)
  }
}
