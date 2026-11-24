import { projectOf, projectStateOf, useStore, workspaceOf } from '../store'
import {
  MERGE_SCOPE,
  PLAN_SCOPE,
  REVIEW_SCOPE,
  TASK_ROOT_SCOPE,
  plannerChatTask,
  type SessionRecord,
  type SessionState,
} from '../types'
import { completeTeamTask, teamFor } from './chatTeams'
import { mergeOutcome, planRead, planWrite, terminalStop } from './ipc'
import { useMainWorktree } from './mainWorktree'
import { DEFAULT_BRANCHES } from './reviewAgents'
import { cleanupJobs, mergeEndsTask, type CleanupJob } from './mergeCleanup'
import {
  BRANCH_RESET_STEPS,
  clearedSimple,
  type BranchReset,
  type BranchResetStep,
  type SimpleState,
} from './simple'
import { flushWorkspace } from './workspace'

/** Branches the main checkout is stored as having; HEAD detaches briefly during a rebase. */
const realBranch = (branch: string | undefined) =>
  !!branch && !branch.startsWith('detached ') ? branch : undefined

const finishedRun = (status: string | undefined) =>
  !!status && ['done', 'stopped', 'failed'].includes(status)

/** Each project's reconcile in flight, so overlapping branch reads never reset twice at once. */
const running = new Map<string, Promise<void>>()
/** Projects whose sessions changed during their reconcile, so it runs once more after. */
const rerun = new Set<string>()

/** A step still waiting on something it doesn't own, such as a running planner. */
const WAITING = 'waiting'
type StepResult = boolean | typeof WAITING

const FIRST_RETRY_MS = 2_000
const MAX_RETRY_MS = 60_000
/** Failed steps, per project and step: when they may run again and the timer that retries them. */
const retries = new Map<
  string,
  { atMs: number; delayMs: number; timer: ReturnType<typeof setTimeout> }
>()
const retryKey = (projectId: string, step: BranchResetStep) => `${projectId}\0${step}`

function clearRetry(key: string) {
  const retry = retries.get(key)
  if (retry) clearTimeout(retry.timer)
  retries.delete(key)
}

/** Back off a failed step, so a rejecting IPC isn't retried on every session update. */
function scheduleRetry(projectId: string, step: BranchResetStep) {
  const key = retryKey(projectId, step)
  const previous = retries.get(key)
  clearRetry(key)
  const delayMs = previous ? Math.min(previous.delayMs * 2, MAX_RETRY_MS) : FIRST_RETRY_MS
  const timer = setTimeout(() => {
    const branch = useMainWorktree.getState()[projectId]?.branch
    void reconcileMainBranch(projectId, branch)
  }, delayMs)
  retries.set(key, { atMs: Date.now() + delayMs, delayMs, timer })
}

/**
 * Note the main checkout's branch. A return from another branch to the default branch means that
 * branch's work is finished: reset the main checkout's Chat to Plan and clear its context.
 */
export function reconcileMainBranch(projectId: string, branch: string | undefined) {
  const previous = running.get(projectId) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(() => reconcile(projectId, branch))
    .finally(() => {
      if (running.get(projectId) !== next) return
      running.delete(projectId)
      if (rerun.delete(projectId))
        void reconcileMainBranch(projectId, useMainWorktree.getState()[projectId]?.branch)
    })
  running.set(projectId, next)
  return next
}

async function reconcile(projectId: string, current: string | undefined) {
  const branch = realBranch(current)
  const state = projectStateOf(projectId)
  if (!branch || !state?.project || useStore.getState().restoring) return
  const simple = workspaceOf(state, null).simple
  const from = simple?.branch
  if (
    from &&
    from !== branch &&
    !DEFAULT_BRANCHES.includes(from) &&
    DEFAULT_BRANCHES.includes(branch)
  )
    resetMainChat(projectId, from, branch)
  else if (from !== branch)
    patchMain(projectId, (s) => ({ ...(s ?? { startedMs: 0, log: [] }), branch }))
  await settleBranchReset(projectId)
}

function patchMain(projectId: string, update: (simple: SimpleState | null) => SimpleState) {
  const state = projectStateOf(projectId)
  if (!state) return
  useStore
    .getState()
    .patchTask(projectId, null, { simple: update(workspaceOf(state, null).simple) })
}

/** Stage, history, Auto and findings reset at once; the plan and lead are retried until done. */
function resetMainChat(projectId: string, from: string, branch: string) {
  const state = projectStateOf(projectId)
  if (!state) return
  const now = Date.now()
  // A new return to main starts its steps fresh, without the last one's backoff.
  for (const step of BRANCH_RESET_STEPS) clearRetry(retryKey(projectId, step))
  const workspace = workspaceOf(state, null)
  const simple = workspace.simple ?? { startedMs: now, log: [] }
  const auto = workspace.auto
  useStore.getState().patchTask(projectId, null, {
    simple: {
      ...clearedSimple(simple, useStore.getState().sessions, now),
      branch,
      workflowResetMs: now,
      branchReset: {
        from,
        atMs: now,
        sinceMs: simple.workflowResetMs,
        pending: [...BRANCH_RESET_STEPS],
      },
    },
    // A finished run worked the old branch; one still owing its lead's completion keeps it.
    ...(auto && finishedRun(auto.status) && !auto.taskDoneAtMs ? { auto: null } : {}),
  })
}

/** Retry whatever part of the last return to main hasn't finished. */
export async function settleBranchReset(projectId: string) {
  const state = projectStateOf(projectId)
  const pending = state && workspaceOf(state, null).simple?.branchReset
  if (!pending) return
  const done: BranchResetStep[] = []
  for (const step of pending.pending) {
    const key = retryKey(projectId, step)
    if ((retries.get(key)?.atMs ?? 0) > Date.now()) continue
    const result: StepResult = await (
      step === 'plan' ? clearMainPlan(projectId, pending) : resetMainLead(projectId, pending)
    ).catch(() => false)
    if (result === WAITING) continue
    if (!result) {
      scheduleRetry(projectId, step)
      continue
    }
    clearRetry(key)
    done.push(step)
  }
  if (!done.length) return
  patchMain(projectId, (s) => {
    if (!s?.branchReset || s.branchReset.atMs !== pending.atMs)
      return s ?? { startedMs: 0, log: [] }
    const left = s.branchReset.pending.filter((step) => !done.includes(step))
    const { branchReset: _done, ...rest } = s
    return left.length ? { ...s, branchReset: { ...s.branchReset, pending: left } } : rest
  })
  await flushWorkspace().catch(() => {})
}

const live = (record: SessionRecord, sessions: Record<string, SessionState>) =>
  sessions[record.id]?.running ?? !!record.snapshot?.running

const mainPlanner = (projectId: string, record: SessionRecord) =>
  record.metadata.projectId === projectId &&
  record.metadata.componentId === PLAN_SCOPE &&
  plannerChatTask(record.metadata.task) === null

/**
 * Empty the main checkout's plan, so new briefings stop carrying the finished branch's plan. A
 * plan saved since the reset is the next task's and stays.
 */
async function clearMainPlan(projectId: string, { atMs }: BranchReset): Promise<StepResult> {
  const { sessionRecords, sessions } = useStore.getState()
  // A planner from the old branch may still be writing its plan; wait for it to finish its turn.
  const writing = sessionRecords.some((r) => {
    const session = sessions[r.id] ?? r.snapshot
    return (
      mainPlanner(projectId, r) &&
      live(r, sessions) &&
      (session?.startedMs ?? 0) <= atMs &&
      session?.status?.agent?.state === 'working'
    )
  })
  if (writing) return WAITING
  const plan = await planRead(projectId)
  if (!plan.text || (plan.savedMs ?? 0) > atMs) return true
  return planWrite(projectId, undefined, '', plan.text)
}

/** The agents Chat launches for its stages; the lead, its sub-builders and the Map stay. */
const STAGE_SCOPES = new Set([TASK_ROOT_SCOPE, REVIEW_SCOPE, MERGE_SCOPE])

/**
 * Whether merge cleanup gives the lead its fresh conversation for this return: a merge of the
 * branch that just finished, started since the reset before, and not abandoned before it merged.
 */
async function mergeCleanupOwnsLead(
  projectId: string,
  root: string,
  { from, sinceMs }: BranchReset,
) {
  const jobs = cleanupJobs().filter(
    (j) =>
      j.projectId === projectId &&
      j.request.source === root &&
      j.request.sourceBranch === from &&
      mergeEndsTask(j.request) &&
      (j.startedMs ?? 0) > (sinceMs ?? 0),
  )
  const project = projectOf(projectId)
  const merging = async (j: CleanupJob) =>
    // A handled job has confirmed its merge; an open one whose merge was aborted never will.
    !!j.handled || (!!project && (await mergeOutcome(project, j.request)) !== 'notMerged')
  for (const job of jobs) if (await merging(job)) return true
  return false
}

/**
 * Give the main checkout's lead a fresh conversation and stop the old branch's stage agents that
 * have finished their turn. An agent still working or waiting on you is left alone.
 */
async function resetMainLead(projectId: string, reset: BranchReset): Promise<StepResult> {
  const root = projectOf(projectId)?.root
  if (!root) return false
  const { sessionRecords, sessions } = useStore.getState()
  const lead = teamFor(projectId, null)?.lead.sessionId
  const stale = sessionRecords.filter((r) => {
    const session = sessions[r.id] ?? r.snapshot
    const agent = session?.status?.agent?.state
    return (
      r.metadata.projectId === projectId &&
      r.metadata.kind === 'agent' &&
      STAGE_SCOPES.has(r.metadata.componentId) &&
      r.id !== lead &&
      !r.metadata.task &&
      r.spec.cwd === root &&
      live(r, sessions) &&
      (session?.startedMs ?? 0) <= reset.atMs &&
      agent !== 'working' &&
      agent !== 'needsInput'
    )
  })
  await Promise.all(stale.map((r) => terminalStop(r.id).catch(() => {})))
  if (!(await mergeCleanupOwnsLead(projectId, root, reset)))
    await completeTeamTask(projectId, null, `branch-reset-${reset.atMs}`, reset.atMs)
  return true
}

/** Reconcile each project's main branch as reads arrive and once restoration finishes. */
export function watchMainBranch() {
  const all = () => {
    for (const [projectId, main] of Object.entries(useMainWorktree.getState()))
      void reconcileMainBranch(projectId, main.branch)
  }
  const offBranches = useMainWorktree.subscribe((now, before) => {
    for (const [projectId, main] of Object.entries(now))
      if (before[projectId]?.branch !== main.branch)
        void reconcileMainBranch(projectId, main.branch)
  })
  const offRestore = useStore.subscribe((now, before) => {
    if (before.restoring && !now.restoring) all()
    // A plan clear waits for the main planner to stop; retry when sessions change. Failed steps
    // back off on their own timer, so they skip these retries until it fires.
    else if (now.sessions !== before.sessions || now.sessionRecords !== before.sessionRecords)
      for (const [projectId, main] of Object.entries(useMainWorktree.getState())) {
        const state = projectStateOf(projectId, now)
        if (!state || !workspaceOf(state, null).simple?.branchReset) continue
        // One in flight may have read the sessions before this change; run once more after it.
        if (running.has(projectId)) rerun.add(projectId)
        else void reconcileMainBranch(projectId, main.branch)
      }
  })
  all()
  return () => {
    offBranches()
    offRestore()
    for (const key of [...retries.keys()]) clearRetry(key)
    rerun.clear()
  }
}
