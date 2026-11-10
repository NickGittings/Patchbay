import type {
  AutoRun,
  AutoStage,
  PlanText,
  Review,
  SessionRecord,
  SessionState,
  Verdict,
} from '../types'
import { MERGE_SCOPE, PLAN_SCOPE, REVIEW_SCOPE, plannerChatTask } from '../types'
import { agentChatTask } from './agentChats'
import { sessionTimeMs } from './sessionList'
import { shortTitle } from './shortTitle'
import { CANVAS_PANEL, CHAT_PANEL, HIERARCHY_PANEL } from './panelLayout'

export const SIMPLE_STAGES = ['plan', 'build', 'review', 'merge'] as const
export type SimpleStage = (typeof SIMPLE_STAGES)[number]
export const SIMPLE_ROLE_LABEL: Record<SimpleStage, string> = {
  plan: 'Planner',
  build: 'Builder',
  review: 'Reviewer',
  merge: 'Merge agent',
}

export const SIMPLE_ACTIONS = [
  'plan',
  'implement',
  'review',
  'fix',
  'merge',
  'validate',
  'autopilot',
  'resume',
  'scope',
  'newConversation',
  'pauseAuto',
  'resumeAuto',
  'stopAuto',
  'mergeApproval',
  'skipStage',
] as const
export type SimpleAction = (typeof SIMPLE_ACTIONS)[number]
interface EntryBase {
  id: string
  atMs: number
  stage: SimpleStage
  sessionId?: string
  generation?: number
}
export type SimpleEntry = EntryBase &
  (
    | { kind: 'prompt'; text: string; mentions: string[] }
    | { kind: 'reply'; sessionId: string; generation: number; sequence: number; text: string }
    | {
        kind: 'action'
        action: SimpleAction
        text?: string
        mentions?: string[]
        request?: import('../types').MergeRequest
      }
  )
export interface SimpleState {
  startedMs: number
  log: SimpleEntry[]
  /** `SIMPLE_VERSION` once saved by a build whose claims name their run; older logs migrate. */
  version?: number
  /** Launch ownership of shared agents, retained even when Chat is disabled. */
  agentRuns?: { sessionId: string; generation: number }[]
  transferredFrom?: string
  transferTarget?: string
  clearBoundary?: {
    atMs: number
    runs: { sessionId: string; generation: number; sequence: number }[]
  }
  /** Text-free facts needed by workflow controls after clearing visible history. */
  retainedWorkflow?: SimpleEntry[]
}
export const SIMPLE_VERSION = 2

export const workflowLog = (simple: SimpleState | null | undefined) =>
  [...(simple?.retainedWorkflow ?? []), ...(simple?.log ?? [])].toSorted(entryOrder)

export function visibleReply(
  simple: SimpleState | null | undefined,
  sid: string,
  generation: number,
  reply: { atMs: number; sequence: number },
) {
  const boundary = simple?.clearBoundary
  if (!boundary) return true
  if (reply.atMs <= boundary.atMs) return false
  return !boundary.runs.some(
    (r) =>
      r.sessionId === sid &&
      (generation < r.generation || (generation === r.generation && reply.sequence <= r.sequence)),
  )
}

export function clearedSimple(
  simple: SimpleState,
  sessions: Record<string, SessionState>,
  atMs: number,
): SimpleState {
  const facts = new Map<string, SimpleEntry>()
  for (const e of workflowLog(simple)) {
    if (e.kind === 'reply') continue
    const fact =
      e.kind === 'prompt'
        ? { ...e, text: '', mentions: [] }
        : { ...e, text: undefined, mentions: undefined }
    const key = `${e.kind}:${e.kind === 'action' ? e.action : ''}:${e.sessionId}:${e.generation}`
    // Keep the first planning boundary as well as the latest delivery/launch fact.
    if (e.stage === 'plan' && !facts.has(`start:${key}`)) facts.set(`start:${key}`, fact)
    facts.set(key, fact)
  }
  const runs = new Map((simple.clearBoundary?.runs ?? []).map((r) => [r.sessionId, r]))
  for (const [sessionId, s] of Object.entries(sessions)) {
    if (s.generation === undefined) continue
    const sequence = Math.max(0, ...(s.replies ?? []).map((r) => r.sequence))
    const old = runs.get(sessionId)
    if (
      !old ||
      old.generation < s.generation ||
      (old.generation === s.generation && old.sequence < sequence)
    )
      runs.set(sessionId, { sessionId, generation: s.generation, sequence })
  }
  for (const e of simple.log)
    if (e.kind === 'reply') {
      const old = runs.get(e.sessionId)
      if (
        !old ||
        old.generation < e.generation ||
        (old.generation === e.generation && old.sequence < e.sequence)
      )
        runs.set(e.sessionId, {
          sessionId: e.sessionId,
          generation: e.generation,
          sequence: e.sequence,
        })
    }
  return boundedSimple({
    ...simple,
    log: [],
    clearBoundary: { atMs, runs: [...runs.values()] },
    retainedWorkflow: [...new Map([...facts.values()].map((e) => [e.id, e])).values()],
  })
}

/** Entries that start, resume or prompt a run, the only ones that may claim it. */
const CLAIMING_ACTIONS: readonly SimpleAction[] = [
  'plan',
  'implement',
  'review',
  'fix',
  'merge',
  'resume',
]
const claimsRun = (e: SimpleEntry) =>
  e.kind === 'prompt' || (e.kind === 'action' && CLAIMING_ACTIONS.includes(e.action))

/**
 * Whether this chat launched, resumed or prompted that run of a shared planner. Only such entries
 * naming the run's generation claim it: one without a generation claims no run, never every later
 * one, and Auto controls claim none.
 */
export function ownsPlanner(
  simple: SimpleState | null | undefined,
  sessionId: string,
  generation: number | undefined,
) {
  return (
    generation !== undefined &&
    (!!simple?.agentRuns?.some((r) => r.sessionId === sessionId && r.generation === generation) ||
      !!workflowLog(simple).some(
        (e) => claimsRun(e) && e.sessionId === sessionId && e.generation === generation,
      ))
  )
}

/** Reapplying old snapshots trims the same oldest text, without persisting per-run cursors. */
export function boundedSimple(simple: SimpleState): SimpleState {
  return {
    ...simple,
    startedMs: simple.startedMs,
    log: boundedSimpleLog(
      simple.log.filter((e) =>
        e.kind === 'reply'
          ? visibleReply(simple, e.sessionId, e.generation, e)
          : !simple.clearBoundary || e.atMs > simple.clearBoundary.atMs,
      ),
    ),
    version: SIMPLE_VERSION,
    ...(simple.agentRuns?.length ? { agentRuns: simple.agentRuns } : {}),
  }
}

/** Chronological, replies after other entries at the same time, then by journal identity. */
const entryOrder = (a: SimpleEntry, b: SimpleEntry) =>
  a.atMs - b.atMs ||
  Number(a.kind === 'reply') - Number(b.kind === 'reply') ||
  (a.kind === 'reply' && b.kind === 'reply'
    ? a.sessionId.localeCompare(b.sessionId) ||
      a.generation - b.generation ||
      a.sequence - b.sequence
    : 0)

/** Keep recent reply text bounded while retaining every prompt and action. */
export const SIMPLE_REPLY_LIMIT = 16 * 1024
export const SIMPLE_REPLY_BUDGET = 128 * 1024
export function boundedSimpleLog(log: SimpleEntry[]): SimpleEntry[] {
  let remaining = SIMPLE_REPLY_BUDGET
  return log
    .toSorted(entryOrder)
    .reverse()
    .flatMap((entry): SimpleEntry[] => {
      if (entry.kind !== 'reply') return [entry]
      if (!remaining) return []
      const limit = Math.min(SIMPLE_REPLY_LIMIT, remaining)
      const suffix = '\n\n[Reply shortened]'
      const text =
        entry.text.length <= limit
          ? entry.text
          : entry.text.slice(0, Math.max(0, limit - suffix.length)) + suffix.slice(0, limit)
      remaining -= text.length
      return [text === entry.text ? entry : { ...entry, text }]
    })
    .reverse()
}

/**
 * Logs saved before `SIMPLE_VERSION` have entries that started or resumed a session (resume above
 * all) without naming its run. Each such entry claims the run of that session's next entry naming
 * one (a prompt or a reply the chat persisted), the run it led into; with none after it, it claims
 * no run. Other entries, Auto controls included, never gain a run. `log` is in `entryOrder`.
 */
function withLegacyGenerations(log: SimpleEntry[]): SimpleEntry[] {
  const next = new Map<string, number>()
  return log
    .toReversed()
    .map((entry) => {
      if (!entry.sessionId) return entry
      if (Number.isSafeInteger(entry.generation)) next.set(entry.sessionId, entry.generation!)
      else if (claimsRun(entry) && next.has(entry.sessionId))
        return { ...entry, generation: next.get(entry.sessionId) } as SimpleEntry
      return entry
    })
    .reverse()
}

/** Old layouts start empty. Never truncate the worktree's action history. */
export function restoredSimple(value: unknown): SimpleState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as SimpleState
  if (!Number.isFinite(state.startedMs) || !Array.isArray(state.log)) return null
  const seen = new Set<string>()
  const replies = new Set<string>()
  const restored = boundedSimple({
    startedMs: state.startedMs,
    transferredFrom: typeof state.transferredFrom === 'string' ? state.transferredFrom : undefined,
    transferTarget: typeof state.transferTarget === 'string' ? state.transferTarget : undefined,
    clearBoundary:
      state.clearBoundary &&
      Number.isFinite(state.clearBoundary.atMs) &&
      Array.isArray(state.clearBoundary.runs)
        ? {
            atMs: state.clearBoundary.atMs,
            runs: state.clearBoundary.runs.filter(
              (r) =>
                !!r &&
                typeof r.sessionId === 'string' &&
                Number.isSafeInteger(r.generation) &&
                r.generation >= 0 &&
                Number.isSafeInteger(r.sequence) &&
                r.sequence >= 0,
            ),
          }
        : undefined,
    retainedWorkflow: Array.isArray(state.retainedWorkflow)
      ? state.retainedWorkflow.flatMap((e) =>
          e &&
          typeof e.id === 'string' &&
          Number.isFinite(e.atMs) &&
          SIMPLE_STAGES.includes(e.stage) &&
          (e.kind === 'prompt' || (e.kind === 'action' && SIMPLE_ACTIONS.includes(e.action)))
            ? [
                e.kind === 'prompt'
                  ? { ...e, text: '', mentions: [] }
                  : { ...e, text: undefined, mentions: undefined },
              ]
            : [],
        )
      : undefined,
    agentRuns: Array.isArray(state.agentRuns)
      ? state.agentRuns.filter(
          (r) =>
            r &&
            typeof r.sessionId === 'string' &&
            Number.isSafeInteger(r.generation) &&
            r.generation >= 0,
        )
      : undefined,
    log: state.log.filter((entry) => {
      if (
        !entry ||
        typeof entry.id !== 'string' ||
        seen.has(entry.id) ||
        !Number.isFinite(entry.atMs) ||
        !SIMPLE_STAGES.includes(entry.stage)
      )
        return false
      const valid =
        entry.kind === 'prompt'
          ? typeof entry.text === 'string' &&
            Array.isArray(entry.mentions) &&
            entry.mentions.every((id) => typeof id === 'string')
          : entry.kind === 'reply'
            ? typeof entry.sessionId === 'string' &&
              Number.isSafeInteger(entry.generation) &&
              entry.generation >= 0 &&
              Number.isSafeInteger(entry.sequence) &&
              entry.sequence > 0 &&
              typeof entry.text === 'string' &&
              !replies.has(`${entry.sessionId}:${entry.generation}:${entry.sequence}`)
            : entry.kind === 'action' && SIMPLE_ACTIONS.includes(entry.action)
      if (valid) {
        seen.add(entry.id)
        if (entry.kind === 'reply')
          replies.add(`${entry.sessionId}:${entry.generation}:${entry.sequence}`)
      }
      return valid
    }),
  })
  return state.version === SIMPLE_VERSION
    ? restored
    : { ...restored, log: withLegacyGenerations(restored.log) }
}
export interface SimpleWorktree {
  projectId: string
  task: string | null
  path: string
  branch?: string | null
}
export interface SimpleSnapshot {
  records: readonly SessionRecord[]
  sessions: Record<string, SessionState>
  simple: SimpleState | null
  auto: AutoRun | null
  plan?: PlanText
  acceptedPlan?: PlanText
  proposal?: import('../types').PlannerProposal | null
  review?: Review
  findings?: import('../types').ReviewFindings | null
  createdMs?: number
}

/** Reconciliation has this long to claim a launch before it falls back to the usual actions. */
export const LAUNCH_RECORD_GRACE_MS = 30_000
/** A launch waits briefly for its run, even when an older run still occupies the session slot. */
export function pendingLaunch(
  snapshot: SimpleSnapshot,
  records: readonly SessionRecord[],
  now = Date.now(),
) {
  const launch = workflowLog(snapshot.simple).findLast(
    (e) =>
      e.kind === 'action' &&
      ['plan', 'implement', 'fix', 'review', 'merge'].includes(e.action) &&
      e.sessionId,
  )
  if (launch?.kind !== 'action' || now - launch.atMs >= LAUNCH_RECORD_GRACE_MS) return undefined
  const record = records.find((r) => r.id === launch.sessionId)
  const generation = record && (snapshot.sessions[record.id] ?? record.snapshot)?.generation
  // A later run supersedes this launch. A launch with no confirmed generation names no run.
  return !record ||
    launch.generation === undefined ||
    generation === undefined ||
    generation < launch.generation
    ? launch
    : undefined
}
export const recordStage = (record: SessionRecord): SimpleStage =>
  record.metadata.componentId === PLAN_SCOPE
    ? 'plan'
    : record.metadata.componentId === REVIEW_SCOPE
      ? 'review'
      : record.metadata.componentId === MERGE_SCOPE
        ? 'merge'
        : 'build'

/** A selected merge also belongs to the chat that launched this specific run and request. */
export function ownsMerge(
  simple: SimpleState | null | undefined,
  record: SessionRecord,
  generation = record.snapshot?.generation,
) {
  return (
    record.metadata.componentId === MERGE_SCOPE &&
    generation !== undefined &&
    !!workflowLog(simple).some(
      (e) =>
        e.kind === 'action' &&
        e.action === 'merge' &&
        e.sessionId === record.id &&
        e.generation === generation &&
        e.request?.source === record.spec.merge_source &&
        e.request?.destination === record.spec.cwd,
    )
  )
}

/** Planners are shared; merges also belong to the chat that selected their request. */
export function relatedSession(
  record: SessionRecord,
  worktree: SimpleWorktree,
  generation = record.snapshot?.generation,
  simple?: SimpleState | null,
) {
  if (record.metadata.projectId !== worktree.projectId || record.metadata.kind !== 'agent')
    return false
  if (record.metadata.componentId === '@map')
    return agentChatTask(record, generation) === worktree.task
  if (record.metadata.componentId === PLAN_SCOPE)
    return record.metadata.task ? plannerChatTask(record.metadata.task) === worktree.task : true
  if (record.metadata.componentId === MERGE_SCOPE)
    return (
      record.spec.merge_source === worktree.path ||
      ownsMerge(simple, record, generation) ||
      (!!worktree.branch && record.metadata.branch === worktree.branch)
    )
  if (record.metadata.componentId === REVIEW_SCOPE) return record.spec.cwd === worktree.path
  return (record.metadata.task ?? null) === worktree.task
}

const stageSessionTime = (record: SessionRecord) =>
  record.snapshot?.startedMs ?? record.history.at(-1)?.startedMs ?? sessionTimeMs(record)

/** The Simple role an Auto stage belongs to. */
export const simpleStageOf = (stage: AutoStage | undefined): SimpleStage =>
  stage === 'plan' || stage === 'scan'
    ? 'plan'
    : stage === 'merge' || stage === 'mergeGate' || stage === 'done'
      ? 'merge'
      : stage === 'review'
        ? 'review'
        : 'build'

/** Start of this planning attempt, rather than a follow-up message within its turn. */
export function planningStarted(snapshot: SimpleSnapshot, worktree?: SimpleWorktree) {
  const log = workflowLog(snapshot.simple)
  const start = log
    .filter(
      (e) =>
        e.stage === 'plan' && (e.kind === 'prompt' || (e.kind === 'action' && e.action === 'plan')),
    )
    .at(-1)
  if (start) {
    const first = log.find(
      (e) =>
        e.stage === 'plan' &&
        e.sessionId === start.sessionId &&
        e.generation === start.generation &&
        (e.kind === 'prompt' || e.kind === 'action'),
    )
    const record = snapshot.records.find((r) => r.id === start.sessionId)
    const atMs = first?.atMs ?? start.atMs
    return start.generation !== undefined &&
      record?.snapshot?.generation !== undefined &&
      record.snapshot.generation !== start.generation
      ? Math.max(atMs, record.snapshot.startedMs)
      : atMs
  }
  if (snapshot.simple?.transferredFrom || worktree?.task === null) return 0
  return snapshot.createdMs ?? snapshot.simple?.startedMs ?? 0
}
export type TimelineItem =
  | {
      kind: 'agent'
      id: string
      atMs: number
      record?: SessionRecord
      sessionId: string
      entries: SimpleEntry[]
    }
  | {
      kind: 'line'
      id: string
      atMs: number
      text: string
      action?: SimpleAction
      stage?: SimpleStage
    }
  | { kind: 'plan'; id: string; atMs: number; text: string; stale: boolean }
  | { kind: 'result'; id: string; atMs: number; result: 'review' | 'merge'; summary?: string }

const actionText = (entry: Extract<SimpleEntry, { kind: 'action' }>) =>
  ({
    plan: `Planning${entry.text ? ` ${entry.text}` : ''}…`,
    implement: 'Building…',
    review: 'Reviewing…',
    fix: 'Fixing findings…',
    merge: 'Checking and merging…',
    validate: 'Running validation…',
    autopilot: 'Auto started.',
    resume: 'Agent resumed.',
    scope: 'Scope updated.',
    newConversation: 'New conversation started with the current Patchbay briefing.',
    pauseAuto: 'Auto paused.',
    resumeAuto: 'Auto resumed.',
    stopAuto: 'Auto stopped.',
    mergeApproval: 'Merge approved.',
    skipStage: 'Stage skipped.',
  })[entry.action]

/** One chronological conversation. Replies use journal identity, never terminal text. */
export function thread(snapshot: SimpleSnapshot, worktree: SimpleWorktree) {
  const records = snapshot.records
    .filter((r) =>
      relatedSession(
        r,
        worktree,
        (snapshot.sessions[r.id] ?? r.snapshot)?.generation,
        snapshot.simple,
      ),
    )
    .sort(
      (a, b) => (stageSessionTime(a) ?? 0) - (stageSessionTime(b) ?? 0) || a.id.localeCompare(b.id),
    )
  let log = [...(snapshot.simple?.log ?? [])]
  const seen = new Set(
    log.flatMap((e) =>
      e.kind === 'reply' ? [`${e.sessionId}:${e.generation}:${e.sequence}`] : [],
    ),
  )
  for (const record of records) {
    const session = snapshot.sessions[record.id] ?? record.snapshot
    const generation = session?.generation
    if (generation === undefined) continue
    for (const reply of session?.replies ?? []) {
      const key = `${record.id}:${generation}:${reply.sequence}`
      if (
        seen.has(key) ||
        !visibleReply(snapshot.simple, record.id, generation, reply) ||
        reply.atMs < (snapshot.simple?.startedMs ?? snapshot.createdMs ?? 0)
      )
        continue
      if (
        recordStage(record) === 'plan' &&
        !record.metadata.task &&
        !ownsPlanner(snapshot.simple, record.id, generation)
      )
        continue
      seen.add(key)
      log.push({
        id: `reply:${key}`,
        kind: 'reply',
        stage: recordStage(record),
        atMs: reply.atMs,
        sessionId: record.id,
        generation,
        sequence: reply.sequence,
        text: reply.text,
      })
    }
  }
  log = boundedSimple({ ...(snapshot.simple ?? { startedMs: snapshot.createdMs ?? 0 }), log }).log
  // The shared planner's current run belongs to the chats that launched or prompted it.
  const foreign = new Set(
    records
      .filter((r) => recordStage(r) === 'plan')
      .filter((r) => {
        const generation = (snapshot.sessions[r.id] ?? r.snapshot)?.generation
        return (
          !r.metadata.task &&
          (!ownsPlanner(snapshot.simple, r.id, generation) ||
            !(snapshot.sessions[r.id] ?? r.snapshot)?.running)
        )
      })
      .map((r) => r.id),
  )
  const workflow = records.filter((r) => r.metadata.componentId !== '@map')
  const latest =
    workflow.filter((r) => recordStage(r) !== 'plan' || !!r.metadata.task).at(-1) ?? workflow.at(-1)
  let stage = latest ? recordStage(latest) : 'plan'
  const action = workflowLog(snapshot.simple)
    .filter(
      (e) =>
        (e.kind === 'action' &&
          ['plan', 'implement', 'review', 'fix', 'merge'].includes(e.action)) ||
        e.kind === 'prompt',
    )
    .at(-1)
  if (action && action.atMs >= (latest ? (stageSessionTime(latest) ?? 0) : 0)) stage = action.stage
  if (snapshot.auto && !['stopped', 'failed', 'done'].includes(snapshot.auto.status))
    stage = simpleStageOf(snapshot.auto.stage)
  const start = planningStarted(snapshot, worktree)
  const plan =
    (snapshot.proposal?.savedMs ?? 0) > (snapshot.plan?.savedMs ?? 0)
      ? { text: snapshot.proposal!.plan, savedMs: snapshot.proposal!.savedMs }
      : snapshot.plan
  const currentPlan = !!plan?.text.trim() && (plan.savedMs ?? 0) >= start
  const items: TimelineItem[] = []
  const planTime = plan?.savedMs ?? 0
  const planItem: TimelineItem | undefined =
    plan?.text.trim() &&
    (!snapshot.simple?.clearBoundary || planTime > snapshot.simple.clearBoundary.atMs)
      ? { kind: 'plan', id: 'plan', atMs: planTime, text: plan.text, stale: !currentPlan }
      : undefined
  let planInserted = false
  const planning = new Set<string>()
  for (const entry of log) {
    if (planItem && !planInserted && entry.atMs >= planTime) {
      items.push(planItem)
      planInserted = true
    }
    if (
      entry.stage === 'plan' &&
      (entry.kind === 'prompt' || (entry.kind === 'action' && entry.action === 'plan'))
    ) {
      const run = `${entry.sessionId}:${entry.generation}`
      if (entry.kind === 'prompt' && !planning.has(run))
        items.push({
          kind: 'line',
          id: `planning:${entry.id}`,
          atMs: entry.atMs - 0.1,
          text: 'Planning…',
          action: 'plan',
          stage: 'plan',
        })
      planning.add(run)
    }
    if (entry.kind === 'action') {
      items.push({
        kind: 'line',
        id: entry.id,
        atMs: entry.atMs,
        text: actionText(entry),
        action: entry.action,
        stage: entry.stage,
      })
      continue
    }
    const sid = entry.sessionId ?? 'you'
    const previous = items.at(-1)
    if (previous?.kind === 'agent' && previous.sessionId === sid) previous.entries.push(entry)
    else
      items.push({
        kind: 'agent',
        id: entry.id,
        atMs: entry.atMs,
        record: records.find((r) => r.id === sid),
        sessionId: sid,
        entries: [entry],
      })
  }
  for (const record of records) {
    if (items.some((i) => i.kind === 'agent' && i.sessionId === record.id)) continue
    if (foreign.has(record.id)) continue
    if (
      snapshot.simple?.clearBoundary &&
      (stageSessionTime(record) ?? 0) <= snapshot.simple.clearBoundary.atMs
    )
      continue
    items.push({
      kind: 'agent',
      id: `agent:${record.id}`,
      atMs: stageSessionTime(record) ?? start,
      record,
      sessionId: record.id,
      entries: [],
    })
  }
  if (planItem && !planInserted) items.push(planItem)
  for (const result of ['review', 'merge'] as const) {
    const r = records.filter((r) => recordStage(r) === result).at(-1)
    if (
      r &&
      (!snapshot.simple?.clearBoundary ||
        (snapshot.sessions[r.id]?.status?.agent?.sinceMs ?? stageSessionTime(r) ?? 0) >
          snapshot.simple.clearBoundary.atMs)
    )
      items.push({
        kind: 'result',
        id: result,
        atMs: snapshot.sessions[r.id]?.status?.agent?.sinceMs ?? stageSessionTime(r) ?? start,
        result,
        summary:
          result === 'review' && snapshot.findings?.verdict
            ? verdictSummary(snapshot.findings.verdict)
            : undefined,
      })
  }
  items.sort(
    (a, b) =>
      a.atMs - b.atMs ||
      Number(b.kind === 'plan') - Number(a.kind === 'plan') ||
      a.id.localeCompare(b.id),
  )
  return { stage, planReady: currentPlan, records, foreign, items, planningStarted: start }
}

/** A review's counts without the zeros, e.g. `1 high, 2 low`; `clean` when nothing was found. */
export function verdictSummary(verdict: Verdict) {
  const found = Object.entries(verdict.counts)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`)
  return found.length ? found.join(', ') : verdict.clean ? 'clean' : 'issues'
}

export interface SimpleSection {
  id: string
  stage: SimpleStage | 'fix'
  title: string
  summary: string
  atMs: number
  items: TimelineItem[]
}

/** Keep artifacts with their chronological stage; only the newest section stays expanded. */
export function sections(
  items: readonly TimelineItem[],
  records: readonly SessionRecord[],
): SimpleSection[] {
  const result: SimpleSection[] = []
  for (const item of items) {
    const current = result.at(-1)
    const action =
      item.kind === 'line' &&
      item.action &&
      ['plan', 'implement', 'fix', 'review', 'merge'].includes(item.action)
    const record =
      item.kind === 'agent'
        ? (item.record ?? records.find((r) => r.id === item.sessionId))
        : undefined
    const stage =
      action && item.kind === 'line'
        ? item.action === 'fix'
          ? 'fix'
          : (item.stage ?? 'plan')
        : record?.metadata.componentId === '@map'
          ? (current?.stage ?? 'plan')
          : record
            ? recordStage(record)
            : item.kind === 'agent'
              ? item.entries[0]?.stage
              : undefined
    const sameStage = current?.stage === stage || (current?.stage === 'fix' && stage === 'build')
    // Several review lanes share one step. Explicit repeated actions still begin a new attempt,
    // except when an immediately preceding launch line has no agent or artifact yet.
    const launchOnly = current?.items.every((i) => i.kind === 'line')
    if (!current || (action && !(sameStage && launchOnly)) || (stage && !sameStage)) {
      const nextStage = stage ?? (item.kind === 'result' ? item.result : 'plan')
      result.push({
        id: item.id,
        stage: nextStage,
        title: SIMPLE_ROLE_LABEL[nextStage === 'fix' ? 'build' : nextStage],
        summary: '',
        atMs: item.atMs,
        items: [item],
      })
    } else current.items.push(item)
  }
  for (const section of result) {
    const plan = section.items.find((i) => i.kind === 'plan')
    const review = section.items.findLast((i) => i.kind === 'result' && i.result === 'review')
    const reply = section.items
      .flatMap((i) => (i.kind === 'agent' ? i.entries : []))
      .findLast((e) => e.kind === 'reply')
    section.summary =
      section.stage === 'plan' && plan?.kind === 'plan'
        ? shortTitle(
            plan.text
              .split('\n')
              .find((line) => line.trim())
              ?.replace(/^#+\s*/, '') ?? '',
          )
        : section.stage === 'review' && review?.kind === 'result' && review.summary
          ? review.summary
          : reply?.kind === 'reply'
            ? shortTitle(reply.text)
            : ''
    section.atMs = section.items.at(-1)?.atMs ?? section.atMs
  }
  return result
}

/** Input waits take priority; otherwise Send and the drawer follow the current role. */
export function selectRecipient(
  records: readonly SessionRecord[],
  sessions: Record<string, SessionState>,
  stage: SimpleStage,
  override?: string,
  /** Shared planner runs this chat never used (`thread`'s `foreign`): their questions aren't its. */
  foreign: ReadonlySet<string> = new Set(),
) {
  const eligible = records.filter((r) => r.metadata.kind === 'agent')
  const asking = [...eligible]
    .reverse()
    .find(
      (r) =>
        !foreign.has(r.id) &&
        sessions[r.id]?.running &&
        !sessions[r.id]?.disconnected &&
        sessions[r.id]?.status?.agent?.state === 'needsInput',
    )
  if (asking) return asking
  const explicit = eligible.find((r) => r.id === override)
  if (explicit) return explicit
  const stageRecords = eligible.filter(
    (r) => r.metadata.componentId !== '@map' && recordStage(r) === stage,
  )
  return (
    [...stageRecords].reverse().find((r) => sessions[r.id]?.running ?? r.snapshot?.running) ??
    stageRecords.at(-1)
  )
}

/** Add the collapsed chat slot to pre-Simple Navigation layouts without changing their sizes. */
export function simplePanelLayout(layout: Record<string, number> | undefined) {
  return layout && !Object.hasOwn(layout, CHAT_PANEL) ? { ...layout, [CHAT_PANEL]: 0 } : layout
}

/** Navigation layouts from before the Hierarchy panel went: the canvas takes its width. */
export function withoutHierarchy(layout: Record<string, number> | undefined) {
  if (!layout || !Object.hasOwn(layout, HIERARCHY_PANEL)) return layout
  const { [HIERARCHY_PANEL]: hierarchy, ...rest } = layout
  return { ...rest, [CANVAS_PANEL]: (rest[CANVAS_PANEL] ?? 0) + hierarchy }
}
