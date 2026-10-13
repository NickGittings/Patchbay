import { projectOf, projectStateOf, useStore } from '../store'
import {
  PLAN_SCOPE,
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
} from '../types'
import {
  agentHooksCheck,
  agentProvider,
  gitBranches,
  gitReview,
  gitWorktrees,
  graphActionRun,
  mergeOutcome,
  planRead,
  proposalRead,
  reviewRead,
  terminalStop,
  graphValidationCancel,
} from './ipc'
import { agentDevices } from './plan'
import { implementPlannerPlan } from './planHandoff'
import { fixReviewFindings } from './reviewHandoff'
import { defaultReviewBase, reviewState, startMergeAgent, startReviewAgent } from './reviewAgents'
import { reconcileFreshSessions, startTerminal } from './sessions'

export const EFFORT: Record<AutoRun['effort'], EffortSettings & { note: string }> = {
  light: {
    maxRounds: 1,
    severityFloor: 'high',
    validate: false,
    note: 'Make minimal, targeted changes.',
  },
  standard: {
    maxRounds: 3,
    severityFloor: 'medium',
    validate: true,
    note: 'Fix properly; add tests where cheap.',
  },
  thorough: {
    maxRounds: 5,
    severityFloor: 'low',
    validate: true,
    note: 'Fix root causes and add tests.',
  },
}
export const STAGE_LABELS: Record<AutoStage, string> = {
  plan: 'Plan',
  implement: 'Implement',
  validate: 'Validate',
  review: 'Review',
  fix: 'Fix',
  mergeGate: 'Merge approval',
  merge: 'Merge',
  done: 'Done',
}
export const STAGES: AutoStage[] = [
  'plan',
  'implement',
  'validate',
  'review',
  'fix',
  'mergeGate',
  'merge',
  'done',
]
const severities: Severity[] = ['critical', 'high', 'medium', 'low']
export function effortSettings(run: Pick<AutoRun, 'effort' | 'overrides'>): EffortSettings {
  return { ...EFFORT[run.effort], ...run.overrides }
}
export function blockingCount(findings: ReviewFindings | null, floor: Severity) {
  return severities
    .slice(0, severities.indexOf(floor) + 1)
    .reduce((sum, s) => sum + (findings?.verdict?.counts[s] ?? 0), 0)
}
const passed = (r: ActionReport['results'][number]) =>
  ['passed', 'started', 'reused'].includes(r.outcome)
/** Components without a validation terminal are skipped, which no fix could change. */
export function actionSucceeded(report: ActionReport) {
  return report.results.every(passed)
}
/** One finding per failed validation terminal, for the fix agent's briefing. */
export function validationFailures(reports: ActionReport[], name: (sessionId: string) => string) {
  return reports
    .flatMap((report) =>
      report.results
        .filter((r) => !passed(r))
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
/** Existing manual work takes precedence over a remembered stage. */
export function inferStage(snapshot: AutoSnapshot, run: AutoRun): Decision {
  const busy = snapshot.agents.find((a) => a.state === 'working' || a.state === 'needsInput')
  if (busy)
    return {
      stage: busy.stage,
      status: busy.state === 'needsInput' ? 'waitingOnYou' : 'running',
      reason: busy.state === 'needsInput' ? 'Agent needs input' : 'Waiting for the current agent',
      sessionId: busy.sessionId,
      turnSince: busy.sinceMs,
      observedWorking: busy.state === 'working',
    }
  if (['merged', 'alreadyIntegrated'].includes(snapshot.outcome))
    return { stage: 'done', status: 'done', reason: 'Branch is integrated' }
  if (snapshot.freshness === 'current') return reviewDecision(run, snapshot.findings)
  if (snapshot.hasChanges)
    return {
      stage: effortSettings(run).validate ? 'validate' : 'review',
      status: 'running',
      reason: `Findings are ${snapshot.freshness}`,
    }
  if (snapshot.plan.trim() || snapshot.proposal)
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
      return ['merged', 'alreadyIntegrated'].includes(outcome ?? '')
        ? { stage: 'done', status: 'done', reason: 'Branch is integrated' }
        : {
            stage: 'merge',
            status: 'waitingOnYou',
            reason: `Merge did not complete (${outcome ?? 'unknown'})`,
          }
    case 'done':
      return { stage: 'done', status: 'done', reason: 'Finished' }
  }
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

function workspace(projectId: string, task: string | null) {
  const state = projectStateOf(projectId)
  return state?.activeTask === task ? state : state?.taskWorkspaces[task ?? '']
}
export const autoRun = (projectId: string, task: string | null) => workspace(projectId, task)?.auto
function patch(projectId: string, task: string | null, update: Partial<AutoRun>, text?: string) {
  const run = autoRun(projectId, task)
  if (!run) return
  useStore.getState().patchTask(projectId, task, {
    auto: {
      ...run,
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
/** Pinned read calls; no active-tab state is consulted after capturing the project. */
export async function autoSnapshot(
  projectId: string,
  task: string | null,
  run: AutoRun,
): Promise<AutoSnapshot> {
  const state = projectStateOf(projectId)
  const project = projectOf(projectId)
  if (!state?.project || !project) throw new Error('Open the project first')
  const [worktrees, branches, saved, proposal, plannerPlan] = await Promise.all([
    gitWorktrees(projectId),
    gitBranches(projectId),
    planRead(projectId, task ?? undefined),
    proposalRead(projectId),
    planRead(projectId),
  ])
  // The project folder is the current worktree, whose top can sit above a project in a subfolder.
  const path = task
    ? state.tasks.find((t) => t.id === task)?.worktree
    : worktrees.find((w) => w.current)?.path
  const source = worktrees.find((w) => w.path === path)
  if (!path || !source?.branch) throw new Error('Choose a worktree with a branch')
  // Review what the merge will bring in: the destination when it is a branch, else the default.
  const destination = run.merge.destinationBranch
  const base =
    destination && destination !== source.branch && branches.includes(destination)
      ? destination
      : defaultReviewBase(source, state.tasks, worktrees, branches)
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
        (r.metadata.componentId === '@task' ||
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
    const a = session?.status?.agent ?? r.snapshot?.status?.agent
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
        state: a?.state ?? 'working',
        sinceMs: a?.sinceMs ?? session?.startedMs ?? r.snapshot?.startedMs ?? Date.now(),
      },
    ]
  })
  const snapshot: AutoSnapshot = {
    // Implement hands off the project plan only, never an older worktree plan.
    plan: plannerPlan.text,
    proposal: !!proposal,
    goal: inferredGoal(
      saved.text || plannerPlan.text,
      state.tasks.find((t) => t.id === task)?.title ?? '',
      state.tasks.find((t) => t.id === task)?.notes ?? '',
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
  if (
    (findings ||
      records.some((r) => r.metadata.componentId === MERGE_SCOPE && r.spec.merge_source === path) ||
      run.stage === 'merge') &&
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
async function checkHooks(deviceId: string) {
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
  startingAuto.add(key)
  try {
    if (['running', 'waitingOnYou', 'paused'].includes(autoRun(projectId, task)?.status ?? ''))
      throw new Error('This worktree already has an Auto run')
    const selectedEffort = effortSettings(settings)
    if (
      !Number.isInteger(selectedEffort.maxRounds) ||
      selectedEffort.maxRounds < 0 ||
      selectedEffort.maxRounds > 100 ||
      !severities.includes(selectedEffort.severityFloor) ||
      typeof selectedEffort.validate !== 'boolean'
    )
      throw new Error('Invalid Advanced effort settings')
    await checkHooks(settings.device)
    const run: AutoRun = {
      ...settings,
      runId: crypto.randomUUID(),
      stage: 'plan',
      status: 'running',
      round: 0,
      log: [],
    }
    const snapshot = await autoSnapshot(projectId, task, run)
    const decision = inferStage(snapshot, run)
    const p = projectStateOf(projectId)
    if (
      decision.sessionId &&
      [null, ...(p?.tasks.map((t) => t.id) ?? [])].some(
        (other) =>
          other !== task &&
          autoRun(projectId, other)?.sessionId === decision.sessionId &&
          ['running', 'waitingOnYou', 'paused'].includes(autoRun(projectId, other)?.status ?? ''),
      )
    )
      throw new Error('This planner or agent already belongs to another Auto run')
    if (settings.stage && decision.sessionId)
      throw new Error('Finish or stop the current agent before overriding its stage')
    if (!run.goal.trim()) run.goal = snapshot.goal
    if ((settings.stage ?? decision.stage) === 'plan' && !run.goal.trim())
      throw new Error('Describe the task first')
    if (!active(projectId, task)) throw new Error('The task changed')
    const reviewedHead = snapshot.freshness === 'current' ? snapshot.source.head : undefined
    // Starting at Merge skips the gate, so an unreviewed branch still waits for approval there.
    const stage = settings.stage === 'merge' && !reviewedHead ? 'mergeGate' : settings.stage
    useStore.getState().patchTask(projectId, task, {
      auto: {
        ...run,
        ...decision,
        reviewedHead,
        findingsSummary:
          snapshot.freshness === 'current' ? snapshot.findings?.text.slice(0, 2000) : undefined,
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
  await checkHooks(run.device)
  const snapshot = await autoSnapshot(projectId, task, run)
  const decision = inferStage(snapshot, run)
  if (autoRun(projectId, task)?.runId !== run.runId) return
  patch(
    projectId,
    task,
    {
      ...decision,
      reviewedHead: snapshot.freshness === 'current' ? snapshot.source.head : undefined,
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
      sessionStartedMs: decision.sessionId
        ? useStore.getState().sessions[decision.sessionId]?.startedMs
        : undefined,
      observedWorking: decision.observedWorking ?? false,
    },
    `Resumed: ${decision.reason}`,
  )
}
function ownsSession(run: AutoRun, sessionId = run.sessionId) {
  return (
    !!sessionId &&
    run.sessionOwned === true &&
    sessionId === run.sessionId &&
    (run.sessionStartedMs === undefined ||
      useStore.getState().sessions[sessionId]?.startedMs === run.sessionStartedMs)
  )
}
export function stopAuto(projectId: string, task: string | null) {
  const run = autoRun(projectId, task)
  patch(projectId, task, { status: 'stopped', reason: 'Stopped by you' }, 'Auto stopped')
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
  const stage: AutoStage =
    run.stage === 'plan'
      ? 'implement'
      : run.stage === 'implement' || run.stage === 'fix' || run.stage === 'validate'
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
const busy = new Set<string>()
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
  try {
    let run = autoRun(projectId, task)!
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
          run.reason?.startsWith('Agent needs input') &&
          agent?.state === 'working' &&
          agent.authoritative &&
          agent.sinceMs > (run.turnSince ?? 0)
        )
          patch(
            projectId,
            task,
            {
              status: 'running',
              turnSince: agent.sinceMs,
              observedWorking: true,
              reason: undefined,
            },
            'Agent resumed work',
          )
        return
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
        if (run.stage === 'plan' && !snapshot.plan.trim() && !snapshot.proposal) {
          pauseAuto(projectId, task, 'Planner finished without a saved plan')
          return
        }
        const other = snapshot.agents.find(
          (a) => a.sessionId !== run.sessionId && ['working', 'needsInput'].includes(a.state),
        )
        const decision = other
          ? inferStage(snapshot, run)
          : nextStep(run, snapshot.findings, snapshot.outcome)
        if (run.stage === 'review' && snapshot.freshness !== 'current') {
          pauseAuto(projectId, task, 'The branch changed during review; Resume to review again')
          return
        }
        const low = snapshot.findings?.verdict
          ? Object.values(snapshot.findings.verdict.counts).reduce((a, b) => a + b, 0) -
            blockingCount(snapshot.findings, effortSettings(run).severityFloor)
          : 0
        if (session?.running && ownsSession(run)) await terminalStop(run.sessionId)
        if (!live()) return
        patch(
          projectId,
          task,
          {
            ...decision,
            sessionId: decision.sessionId,
            sessionOwned: decision.sessionId === run.sessionId && ownsSession(run),
            sessionStartedMs: decision.sessionId
              ? useStore.getState().sessions[decision.sessionId]?.startedMs
              : undefined,
            launchAtMs: undefined,
            reason:
              run.stage === 'merge' && decision.status === 'waitingOnYou'
                ? `${decision.reason}${agent.message ? ': ' + agent.message : ''}`
                : decision.reason,
            turnSince: decision.turnSince,
            observedWorking: decision.observedWorking ?? false,
            reviewedHead: run.stage === 'review' ? snapshot.source.head : run.reviewedHead,
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
    const device = agentDevices(useStore.getState().devices).find((d) => d.id === run.device)
    if (!device) throw new Error('The selected agent preset is unavailable')
    // Stop any completed prior Auto agent before issuing a new startup briefing.
    if (!live()) return
    run = live()!
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
      useStore.getState().patchTask(projectId, task, { graphActionBusy: true })
      validating.add(key)
      try {
        if (snapshot.changedComponents.length) {
          if (!live()) return
          const request = {
            kind: 'validateChanged' as const,
            componentIds: snapshot.changedComponents,
          }
          useStore.getState().patchTask(projectId, task, { graphAction: request })
          const report = await graphActionRun(project, request, task ?? undefined)
          reports.push(report)
          useStore.getState().patchTask(projectId, task, { graphActionReport: report })
        }
      } finally {
        validating.delete(key)
        useStore.getState().patchTask(projectId, task, { graphActionBusy: false })
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
      { turnSince: since, launchAtMs: since, observedWorking: false },
      `Starting ${run.stage}${run.stage === 'fix' ? ` round ${run.round + 1}` : ''}`,
    )
    if (!live() || !active(projectId, task)) return
    switch (run.stage) {
      case 'plan':
        sid = plannerSessionId(run.device, projectId)
        if (useStore.getState().sessions[sid]?.running) {
          pauseAuto(
            projectId,
            task,
            'Close the current planner before starting another in this slot',
          )
          return
        }
        if (!live() || !active(projectId, task)) return
        await startTerminal(PLAN_SCOPE, run.device, task, projectId, 'plan', brief)
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
    const latest = autoRun(projectId, task)
    if (latest?.runId !== runId || latest.status === 'stopped' || latest.status === 'done') {
      await terminalStop(sid)
      return
    }
    patch(projectId, task, {
      sessionId: sid,
      sessionOwned: true,
      sessionStartedMs: useStore.getState().sessions[sid]?.startedMs,
      turnSince: since,
    })
  } catch (e) {
    if (live()) patch(projectId, task, { status: 'failed', reason: String(e) }, String(e))
  } finally {
    busy.delete(key)
  }
}
/** The main window owns a single driver; the timer also polls findings every five seconds. */
export function followAuto() {
  let queued = false
  let disposed = false
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
        for (const task of [null, ...p.tasks.map((t) => t.id)]) {
          const run = autoRun(id, task)
          if (
            run &&
            (run.status === 'running' ||
              (run.status === 'waitingOnYou' && run.reason?.startsWith('Agent needs input')))
          )
            void drive(id, task)
        }
      }
    })
  }
  const unsubscribe = useStore.subscribe(tick)
  const interval = setInterval(tick, 5000)
  tick()
  return () => {
    disposed = true
    unsubscribe()
    clearInterval(interval)
    completionPolls.clear()
  }
}
