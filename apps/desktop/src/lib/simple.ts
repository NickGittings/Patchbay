import type { AutoRun, AutoStage, PlanText, Review, SessionRecord, SessionState } from '../types'
import { MERGE_SCOPE, PLAN_SCOPE, REVIEW_SCOPE } from '../types'
import { sessionTimeMs } from './sessionList'

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
}

/** Legacy prompts without a generation claim the planner's current run too. */
export function ownsPlanner(
  simple: SimpleState | null | undefined,
  sessionId: string,
  generation: number | undefined,
) {
  return !!simple?.log.some(
    (e) =>
      e.kind !== 'reply' &&
      e.sessionId === sessionId &&
      (e.generation === undefined || e.generation === generation),
  )
}

/** Reapplying old snapshots trims the same oldest text, without persisting per-run cursors. */
export function boundedSimple(simple: SimpleState): SimpleState {
  return {
    startedMs: simple.startedMs,
    log: boundedSimpleLog(simple.log),
  }
}

/** Keep recent reply text bounded while retaining every prompt and action. */
export const SIMPLE_REPLY_LIMIT = 16 * 1024
export const SIMPLE_REPLY_BUDGET = 128 * 1024
export function boundedSimpleLog(log: SimpleEntry[]): SimpleEntry[] {
  let remaining = SIMPLE_REPLY_BUDGET
  return log
    .toSorted(
      (a, b) =>
        a.atMs - b.atMs ||
        Number(a.kind === 'reply') - Number(b.kind === 'reply') ||
        (a.kind === 'reply' && b.kind === 'reply'
          ? a.sessionId.localeCompare(b.sessionId) ||
            a.generation - b.generation ||
            a.sequence - b.sequence
          : 0),
    )
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

/** Old layouts start empty. Never truncate the worktree's action history. */
export function restoredSimple(value: unknown): SimpleState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as SimpleState
  if (!Number.isFinite(state.startedMs) || !Array.isArray(state.log)) return null
  const seen = new Set<string>()
  const replies = new Set<string>()
  return boundedSimple({
    startedMs: state.startedMs,
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
  createdMs?: number
}
export const recordStage = (record: SessionRecord): SimpleStage =>
  record.metadata.componentId === PLAN_SCOPE
    ? 'plan'
    : record.metadata.componentId === REVIEW_SCOPE
      ? 'review'
      : record.metadata.componentId === MERGE_SCOPE
        ? 'merge'
        : 'build'

/** Project planners are explicitly shared; every other record must belong to this worktree. */
export function relatedSession(record: SessionRecord, worktree: SimpleWorktree) {
  if (
    record.metadata.projectId !== worktree.projectId ||
    record.metadata.kind !== 'agent' ||
    record.metadata.componentId === '@map'
  )
    return false
  if (record.metadata.componentId === PLAN_SCOPE) return true
  if (record.metadata.componentId === MERGE_SCOPE)
    return (
      record.spec.merge_source === worktree.path ||
      (!!worktree.branch && record.metadata.branch === worktree.branch)
    )
  if (record.metadata.componentId === REVIEW_SCOPE) return record.spec.cwd === worktree.path
  return (record.metadata.task ?? null) === worktree.task
}

const stageSessionTime = (record: SessionRecord) =>
  record.snapshot?.startedMs ?? record.history.at(-1)?.startedMs ?? sessionTimeMs(record)

/** The Simple role an Auto stage belongs to. */
export const simpleStageOf = (stage: AutoStage | undefined): SimpleStage =>
  stage === 'plan'
    ? 'plan'
    : stage === 'merge' || stage === 'mergeGate' || stage === 'done'
      ? 'merge'
      : stage === 'review'
        ? 'review'
        : 'build'

/** Start of this planning attempt, rather than a follow-up message within its turn. */
export function planningStarted(snapshot: SimpleSnapshot) {
  const log = snapshot.simple?.log ?? []
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
  | { kind: 'line'; id: string; atMs: number; text: string }
  | { kind: 'plan'; id: string; atMs: number; text: string; stale: boolean }
  | { kind: 'result'; id: string; atMs: number; result: 'review' | 'changes' | 'merge' }

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
    pauseAuto: 'Auto paused.',
    resumeAuto: 'Auto resumed.',
    stopAuto: 'Auto stopped.',
    mergeApproval: 'Merge approved.',
    skipStage: 'Stage skipped.',
  })[entry.action]

/** One chronological conversation. Replies use journal identity, never terminal text. */
export function thread(snapshot: SimpleSnapshot, worktree: SimpleWorktree) {
  const records = snapshot.records
    .filter((r) => relatedSession(r, worktree))
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
      if (seen.has(key) || reply.atMs < (snapshot.simple?.startedMs ?? snapshot.createdMs ?? 0))
        continue
      if (recordStage(record) === 'plan' && !ownsPlanner(snapshot.simple, record.id, generation))
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
  log = boundedSimpleLog(log)
  // The shared planner's current run belongs to the chats that launched or prompted it.
  const foreign = new Set(
    records
      .filter((r) => recordStage(r) === 'plan')
      .filter((r) => {
        const generation = (snapshot.sessions[r.id] ?? r.snapshot)?.generation
        return !ownsPlanner(snapshot.simple, r.id, generation)
      })
      .map((r) => r.id),
  )
  const latest = records.filter((r) => recordStage(r) !== 'plan').at(-1) ?? records.at(-1)
  let stage = latest ? recordStage(latest) : 'plan'
  const action = log
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
  const start = planningStarted(snapshot)
  const plan =
    (snapshot.proposal?.savedMs ?? 0) > (snapshot.plan?.savedMs ?? 0)
      ? { text: snapshot.proposal!.plan, savedMs: snapshot.proposal!.savedMs }
      : snapshot.plan
  const currentPlan = !!plan?.text.trim() && (plan.savedMs ?? 0) >= start
  const items: TimelineItem[] = []
  const planning = new Set<string>()
  for (const entry of log) {
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
        })
      planning.add(run)
    }
    if (entry.kind === 'action') {
      items.push({ kind: 'line', id: entry.id, atMs: entry.atMs, text: actionText(entry) })
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
    items.push({
      kind: 'agent',
      id: `agent:${record.id}`,
      atMs: stageSessionTime(record) ?? start,
      record,
      sessionId: record.id,
      entries: [],
    })
  }
  const plannerEnd = Math.max(
    0,
    ...log.filter((e) => e.stage === 'plan' && e.kind === 'reply').map((e) => e.atMs),
  )
  if (plan?.text.trim())
    items.push({
      kind: 'plan',
      id: 'plan',
      atMs: currentPlan ? Math.max(plan.savedMs ?? 0, plannerEnd) + 0.1 : start,
      text: plan.text,
      stale: !currentPlan,
    })
  for (const result of ['changes', 'review', 'merge'] as const) {
    const r = records
      .filter((r) => recordStage(r) === (result === 'changes' ? 'build' : result))
      .at(-1)
    if (r)
      items.push({
        kind: 'result',
        id: result,
        atMs: snapshot.sessions[r.id]?.status?.agent?.sinceMs ?? stageSessionTime(r) ?? start,
        result,
      })
  }
  items.sort((a, b) => a.atMs - b.atMs)
  return { stage, planReady: currentPlan, records, foreign, items, planningStarted: start }
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
  const stageRecords = eligible.filter((r) => recordStage(r) === stage)
  return (
    [...stageRecords].reverse().find((r) => sessions[r.id]?.running ?? r.snapshot?.running) ??
    stageRecords.at(-1)
  )
}

/** Add the collapsed chat slot to pre-Simple Navigation layouts without changing their sizes. */
export function simplePanelLayout(layout: Record<string, number> | undefined) {
  return layout && !Object.hasOwn(layout, 'App-simple-chat')
    ? { ...layout, 'App-simple-chat': 0 }
    : layout
}

/** Navigation layouts from before the Hierarchy panel went: the canvas takes its width. */
export function withoutHierarchy(layout: Record<string, number> | undefined) {
  if (!layout || !Object.hasOwn(layout, 'App-pane-1')) return layout
  const { 'App-pane-1': hierarchy, ...rest } = layout
  return { ...rest, 'App-pane-2': (rest['App-pane-2'] ?? 0) + hierarchy }
}
