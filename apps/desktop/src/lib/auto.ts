import { shallow } from 'zustand/shallow'
import { projectOf, projectStateOf, useStore } from '../store'
import {
  PLAN_SCOPE,
  TASK_ROOT_SCOPE,
  REVIEW_SCOPE,
  MERGE_SCOPE,
  plannerSessionId,
  type AutoBrief,
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
import { defaultReviewBase, reviewState, startMergeAgent, startReviewAgent } from './reviewAgents'
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
            `[high] Validation failed: ${name(r.sessionId)} ${r.outcome}${r.exitCode === null ? '' : ` (exit ${r.exitCode})`}`,
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
      stage: effortSettings(run).validate ? 'validate' : 'review',
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
      return step(
        effortSettings(run).validate ? 'validate' : 'review',
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
      ...update,
      log: text ? [...run.log, { atMs: Date.now(), text }].slice(-100) : run.log,
    },
  })
}
function active(projectId: string, task: string | null) {
  const s = useStore.getState()
  return s.project?.id === projectId && s.activeTask === task
}
function mergeRequest(snapshot: AutoSnapshot, run: AutoRun) {
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
  // The task list loads after a restored layout, so a run resumed early loads it first.
  if (task && !projectStateOf(projectId)?.tasks.some((t) => t.id === task))
    await refreshTasks(projectId)
  const tasks = projectStateOf(projectId)?.tasks ?? state.tasks
  // The project folder is the current worktree, whose top can sit above a project in a subfolder.
  const path = task
    ? tasks.find((t) => t.id === task)?.worktree
    : worktrees.find((w) => w.current)?.path
  const source = worktrees.find((w) => w.path === path)
  if (!path || !source?.branch) throw new Error('Choose a worktree with a branch')
  // Review what the merge will bring in: the destination when it is a branch, else the default.
  const destination = run.merge.destinationBranch
  const base =
    destination && destination !== source.branch && branches.includes(destination)
      ? destination
      : defaultReviewBase(source, tasks, worktrees, branches)
  if (!base) throw new Error('No review base found; choose another worktree')
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
    goal: inferredGoal(
      saved.text || plannerPlan.text,
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
export type AutoSettings = Pick<AutoRun, 'goal' | 'effort' | 'overrides' | 'merge' | 'device'> & {
  stage?: AutoStage
}
export async function checkAutoHooks(deviceId: string) {
  const device = agentDevices(useStore.getState().devices).find((d) => d.id === deviceId)
  const provider = device ? await agentProvider(device) : null
  if (!provider) throw new Error('Choose an agent preset with Claude or Codex status integration')
  const hooks = await agentHooksCheck(provider)
  if (!hooks.installed || hooks.disabled || !hooks.reporterAvailable)
    throw new Error('Install Agent status integration before starting Auto mode')
}
const startingAuto = new Set<string>()
/** Worktrees whose Auto run is running a validation right now. */
const validating = new Set<string>()
export async function startAuto(projectId: string, task: string | null, settings: AutoSettings) {
  const key = JSON.stringify([projectId, task])
  if (startingAuto.has(key)) throw new Error('Auto is already starting in this worktree')
  if (launching.has(key))
    throw new Error('Auto is still starting an agent; Start once it has started')
  startingAuto.add(key)
  try {
    if (unfinished(autoRun(projectId, task)?.status))
      throw new Error('This worktree already has an Auto run')
    if (!validOverrides(settings.overrides ?? {}))
      throw new Error('Invalid Advanced effort settings')
    await checkAutoHooks(settings.device)
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
    if (launching.has(key))
      throw new Error('Auto is still starting an agent; Start once it has started')
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
    startingAuto.delete(key)
  }
}
export function pauseAuto(projectId: string, task: string | null, reason = 'Paused by you') {
  patch(projectId, task, { status: 'paused', reason }, reason)
}
export async function resumeAuto(projectId: string, task: string | null) {
  const run = autoRun(projectId, task)
  if (!run) return
  // Resume changes the run id, so let a pending launch attach its session first.
  if (launching.has(JSON.stringify([projectId, task])))
    throw new Error('Auto is still starting an agent; Resume once it has started')
  const snapshot = await autoSnapshot(projectId, task, run, true)
  if (launching.has(JSON.stringify([projectId, task])))
    throw new Error('Auto is still starting an agent; Resume once it has started')
  // Pause preserves runId; a new status or another Pause still cancels this Resume.
  if (autoRun(projectId, task) !== run) return
  const decision = inferStage(snapshot, run)
  if (['plan', 'implement', 'review', 'fix', 'merge'].includes(decision.stage))
    await checkAutoHooks(run.device)
  if (launching.has(JSON.stringify([projectId, task])))
    throw new Error('Auto is still starting an agent; Resume once it has started')
  if (autoRun(projectId, task) !== run) return
  assertSessionAvailable(projectId, task, decision.sessionId)
  patch(
    projectId,
    task,
    {
      ...decision,
      reviewedHead: mergeableHead(snapshot, run),
      findingsSummary:
        snapshot.freshness === 'current'
          ? snapshot.findings?.text.slice(0, 2000)
          : run.findingsSummary,
      runId: crypto.randomUUID(),
      launchAtMs:
        decision.sessionId === run.sessionId && ownsSession(run) ? run.launchAtMs : undefined,
      sessionId: decision.sessionId,
      sessionOwned: decision.sessionId === run.sessionId && ownsSession(run),
      turnSince: decision.turnSince,
      sessionStartedMs: decision.sessionId ? startedOf(decision.sessionId) : undefined,
      observedWorking: decision.observedWorking ?? false,
    },
    `Resumed: ${decision.reason}`,
  )
}
/** A session's start time, from its record when this window hasn't hydrated it yet. */
function startedOf(sid: string) {
  const s = useStore.getState()
  return (
    s.sessions[sid]?.startedMs ?? s.sessionRecords.find((r) => r.id === sid)?.snapshot?.startedMs
  )
}
function ownsSession(run: AutoRun, sessionId = run.sessionId) {
  return (
    !!sessionId &&
    run.sessionOwned === true &&
    sessionId === run.sessionId &&
    // Without the launch's start time, a later session under this id would count as Auto's.
    run.sessionStartedMs !== undefined &&
    startedOf(sessionId) === run.sessionStartedMs
  )
}
export function stopAuto(projectId: string, task: string | null) {
  const run = autoRun(projectId, task)
  patch(
    projectId,
    task,
    { runId: crypto.randomUUID(), status: 'stopped', reason: 'Stopped by you' },
    'Auto stopped',
  )
  if (run?.sessionId && ownsSession(run))
    void terminalStop(run.sessionId).catch((e) => useStore.getState().setMessage(String(e)))
  if (validating.has(JSON.stringify([projectId, task])))
    void graphValidationCancel(projectId).catch((e) => useStore.getState().setMessage(String(e)))
}
export async function skipStage(projectId: string, task: string | null) {
  const run = autoRun(projectId, task)
  if (!run || run.status === 'running') return
  if (run.sessionId && ownsSession(run) && useStore.getState().sessions[run.sessionId]?.running) {
    await terminalStop(run.sessionId)
    if (
      autoRun(projectId, task)?.runId !== run.runId ||
      autoRun(projectId, task)?.status === 'running'
    )
      return
  }
  // Skipping a fix that never started (its budget ran out) accepts the findings, so it goes to the
  // merge gate; a fix that ran still gets its work reviewed.
  const stage: AutoStage =
    run.stage === 'plan'
      ? 'implement'
      : run.stage === 'implement' ||
          run.stage === 'validate' ||
          (run.stage === 'fix' && run.sessionId)
        ? 'review'
        : 'mergeGate'
  // Skipping review cannot grant automatic merge permission.
  patch(
    projectId,
    task,
    {
      runId: crypto.randomUUID(),
      sessionId: undefined,
      sessionOwned: false,
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
const busy = new Set<string>()
const launching = new Set<string>()
const gatePolls = new Map<string, { runId: string; atMs: number }>()
const completionPolls = new Map<string, { turn: string; atMs: number }>()
async function drive(projectId: string, task: string | null) {
  const key = JSON.stringify([projectId, task])
  if (busy.has(key)) return
  const initial = autoRun(projectId, task)
  if (!initial || !['running', 'waitingOnYou'].includes(initial.status)) return
  const runId = initial.runId
  const live = () => {
    const r = autoRun(projectId, task)
    return r?.runId === runId && r.status === 'running' ? r : null
  }
  busy.add(key)
  let reservedSession: string | undefined
  try {
    let run = autoRun(projectId, task)!
    // Approval waits still observe Git, including a merge performed outside Auto.
    if (run.stage === 'mergeGate' && run.status === 'waitingOnYou' && !run.sessionId) {
      const previous = gatePolls.get(key)
      if (previous?.runId === runId && Date.now() - previous.atMs < 5000) return
      gatePolls.set(key, { runId, atMs: Date.now() })
      const snapshot = await autoSnapshot(projectId, task, run)
      const latest = autoRun(projectId, task)
      if (
        latest?.runId !== runId ||
        latest.stage !== 'mergeGate' ||
        latest.status !== 'waitingOnYou'
      )
        return
      if (integrated(snapshot.outcome))
        patch(
          projectId,
          task,
          { stage: 'done', status: 'done', reason: 'Branch is integrated' },
          'Branch is integrated',
        )
      return
    }
    if (run.sessionId) {
      const session = useStore.getState().sessions[run.sessionId]
      const agent = session?.status?.agent
      if (
        !session &&
        useStore.getState().serviceConnected &&
        !useStore.getState().sessionRecords.some((r) => r.id === run.sessionId)
      ) {
        pauseAuto(projectId, task, 'The tracked session was forgotten')
        return
      }
      if (
        run.status === 'waitingOnYou' &&
        session &&
        (!session.running ||
          session.status?.stopped ||
          (agent?.state === 'idle' && agent.sinceMs >= (run.turnSince ?? 0)))
      ) {
        pauseAuto(projectId, task, 'Agent stopped while waiting for input')
        return
      }
      if (run.status === 'waitingOnYou') {
        if (
          run.waitingFor !== 'agentInput' ||
          !agent?.authoritative ||
          !['working', 'review'].includes(agent.state) ||
          agent.sinceMs <= (run.turnSince ?? 0)
        )
          return
        // Completion can arrive before the monitor ever observes working.
        patch(
          projectId,
          task,
          {
            status: 'running',
            turnSince: agent.state === 'working' ? agent.sinceMs : run.turnSince,
            observedWorking: true,
            reason: undefined,
          },
          agent.state === 'review' ? 'Agent finished work' : 'Agent resumed work',
        )
        run = live()!
      }
      if (
        session?.status?.stopped ||
        (run.sessionStartedMs && session?.startedMs !== run.sessionStartedMs)
      ) {
        pauseAuto(projectId, task, 'The tracked session was stopped or relaunched by hand')
        return
      }
      if (agent?.state === 'needsInput' && agent.authoritative) {
        patch(
          projectId,
          task,
          {
            status: 'waitingOnYou',
            waitingFor: 'agentInput',
            reason: `Agent needs input${agent.message ? ': ' + agent.message : ''}`,
          },
          'Agent needs input',
        )
        return
      }
      if (
        agent?.state === 'review' &&
        agent.authoritative &&
        agent.sinceMs > (run.turnSince ?? 0)
      ) {
        const turn = JSON.stringify([run.runId, run.sessionId, agent.sinceMs])
        const previous = completionPolls.get(key)
        if (previous?.turn === turn && Date.now() - previous.atMs < 5000) return
        completionPolls.set(key, { turn, atMs: Date.now() })
        const snapshot = await autoSnapshot(projectId, task, run)
        if (!live()) return
        // Never advance on a previous attempt's saved findings.
        if (
          run.stage === 'review' &&
          (!snapshot.findings?.reviewedHead ||
            (run.launchAtMs !== undefined && snapshot.findings.startedMs < run.launchAtMs))
        ) {
          if (Date.now() - agent.sinceMs > 30000)
            pauseAuto(projectId, task, "Couldn't read the review verdict — open findings")
          return
        }
        // A plan saved before this planner launched is no answer to its goal.
        if (
          run.stage === 'plan' &&
          ((!snapshot.plan.trim() && !snapshot.proposal) ||
            (run.planMark !== undefined && snapshot.planMark === run.planMark))
        ) {
          pauseAuto(projectId, task, 'Planner finished without saving a new plan')
          return
        }
        const other = snapshot.agents.find(
          (a) => a.sessionId !== run.sessionId && ['working', 'needsInput'].includes(a.state),
        )
        // Another agent at this stage keeps working on it: wait for it rather than advance, and
        // keep tracking the run's own agent.
        if (other?.stage === run.stage) {
          completionPolls.delete(key)
          const reason = 'Waiting for another agent in this worktree to finish'
          if (run.reason !== reason) patch(projectId, task, { reason }, reason)
          return
        }
        const decision = other
          ? inferStage(snapshot, run)
          : nextStep(run, snapshot.findings, snapshot.outcome)
        if (run.stage === 'review' && snapshot.freshness !== 'current') {
          pauseAuto(projectId, task, 'The branch changed during review; Resume to review again')
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
        if (finished && session?.running && (ownsSession(run) || run.stage === 'plan'))
          await terminalStop(run.sessionId!)
        if (!live()) return
        patch(
          projectId,
          task,
          {
            ...decision,
            // A kept agent stays tracked, so Stop still ends it.
            ...(finished
              ? {
                  sessionId: decision.sessionId,
                  sessionOwned: decision.sessionId === run.sessionId && ownsSession(run),
                  sessionStartedMs: decision.sessionId ? startedOf(decision.sessionId) : undefined,
                }
              : {}),
            launchAtMs: undefined,
            reason:
              run.stage === 'merge' && decision.status === 'waitingOnYou'
                ? `${decision.reason}${agent.message ? ': ' + agent.message : ''}`
                : decision.reason,
            turnSince: decision.waitingFor === 'agentInput' ? agent.sinceMs : decision.turnSince,
            observedWorking: decision.observedWorking ?? false,
            reviewedHead: run.stage === 'review' ? mergeableHead(snapshot, run) : run.reviewedHead,
            findingsSummary:
              run.stage === 'review' ? snapshot.findings?.text.slice(0, 2000) : run.findingsSummary,
          },
          `${decision.reason}${low ? `; ${low} finding(s) below the severity floor remain` : ''}`,
        )
        return
      }
      if (
        session &&
        (!session.running ||
          (agent &&
            (run.observedWorking || agent.state === 'ended') &&
            ['idle', 'ended'].includes(agent.state) &&
            agent.sinceMs >= (run.turnSince ?? 0)))
      ) {
        pauseAuto(projectId, task, agent?.message || 'Agent stopped before finishing its turn')
        return
      }
      if (
        agent?.state === 'working' &&
        agent.authoritative &&
        (!run.observedWorking || agent.sinceMs > (run.turnSince ?? 0))
      )
        patch(projectId, task, {
          turnSince: Math.max(run.turnSince ?? 0, agent.sinceMs),
          observedWorking: true,
        })
      return
    }
    completionPolls.delete(key)
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
      patch(
        projectId,
        task,
        { stage: 'done', status: 'done', reason: 'Branch is integrated' },
        'Branch is integrated',
      )
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
      validating.add(key)
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
        validating.delete(key)
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
    const device = agentDevices(useStore.getState().devices).find((d) => d.id === run.device)
    if (!device) throw new Error('The selected agent preset is unavailable')
    await checkAutoHooks(run.device)
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
    launching.add(key)
    switch (run.stage) {
      case 'plan':
        sid = plannerSessionId(run.device, projectId)
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
        await startTerminal(PLAN_SCOPE, run.device, task, projectId, {
          kickoff: { kind: 'plan' },
          auto: brief,
        })
        break
      case 'implement':
        sid = await implementPlannerPlan(run.device, brief)
        break
      case 'review':
        sid = await startReviewAgent(
          project,
          { worktree: snapshot.source.path, branch: snapshot.source.branch!, base: snapshot.base },
          device,
          crypto.randomUUID(),
          brief,
        )
        break
      case 'fix':
        if (!snapshot.reviewRecord)
          throw new Error('Open findings and start a review before fixing')
        sid = await fixReviewFindings(snapshot.reviewRecord, brief, run.device)
        if (autoRun(projectId, task)?.runId === runId)
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
    await reconcileFreshSessions()
    if (
      !useStore.getState().sessions[sid] &&
      !useStore.getState().sessionRecords.some((r) => r.id === sid)
    )
      throw new Error('Agent launch was not confirmed; Resume to try again')
    const startedMs = startedOf(sid) ?? (await terminalSnapshot(sid))?.startedMs
    const latest = autoRun(projectId, task)
    if (latest?.runId !== runId || latest.status === 'stopped' || latest.status === 'done') {
      await terminalStop(sid)
      return
    }
    patch(projectId, task, {
      sessionId: sid,
      // Owned only with its start time, so a later session under this id never is.
      sessionOwned: startedMs !== undefined,
      sessionStartedMs: startedMs,
      sessionBrief: {
        sessionId: sid,
        auto: brief,
        kickoff: run.stage === 'plan' ? { kind: 'plan' } : undefined,
      },
      turnSince: since,
    })
  } catch (e) {
    const latest = autoRun(projectId, task)
    if (
      latest?.runId === runId &&
      (latest.status === 'running' ||
        (latest.status === 'waitingOnYou' && latest.stage === 'mergeGate'))
    )
      patch(projectId, task, { status: 'failed', reason: String(e) }, String(e))
  } finally {
    if (reservedSession && launchingSessions.get(reservedSession) === key)
      launchingSessions.delete(reservedSession)
    launching.delete(key)
    busy.delete(key)
  }
}
/** The main window owns a single driver; the timer also polls findings every five seconds. */
export function followAuto() {
  let queued = false
  let disposed = false
  const driving = new Set<string>()
  const pending = new Set<string>()
  const schedule = (projectId: string, task: string | null) => {
    if (disposed) return
    const key = JSON.stringify([projectId, task])
    if (driving.has(key)) {
      pending.add(key)
      return
    }
    driving.add(key)
    void drive(projectId, task).finally(() => {
      driving.delete(key)
      if (pending.delete(key)) schedule(projectId, task)
    })
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
    unsubscribe()
    clearInterval(interval)
    completionPolls.clear()
    gatePolls.clear()
  }
}
