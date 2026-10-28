import type { AutoRun, AutoStage, PlanText, Review, SessionRecord, SessionState } from '../types'
import { MERGE_SCOPE, PLAN_SCOPE, REVIEW_SCOPE } from '../types'
import { sessionTimeMs } from './sessionList'
import { shortTitle } from './shortTitle'

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
  /** `SIMPLE_VERSION` once saved by a build whose claims name their run; older logs migrate. */
  version?: number
}
export const SIMPLE_VERSION = 2

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
    !!simple?.log.some(
      (e) => claimsRun(e) && e.sessionId === sessionId && e.generation === generation,
    )
  )
}

/** Reapplying old snapshots trims the same oldest text, without persisting per-run cursors. */
export function boundedSimple(simple: SimpleState): SimpleState {
  return {
    startedMs: simple.startedMs,
    log: boundedSimpleLog(simple.log),
    version: SIMPLE_VERSION,
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
  for (const result of ['review', 'merge'] as const) {
    const r = records.filter((r) => recordStage(r) === result).at(-1)
    if (r)
      items.push({
        kind: 'result',
        id: result,
        atMs: snapshot.sessions[r.id]?.status?.agent?.sinceMs ?? stageSessionTime(r) ?? start,
        result,
        summary:
          result === 'review' && snapshot.findings?.verdict
            ? Object.entries(snapshot.findings.verdict.counts)
                .map(([severity, count]) => `${count} ${severity}`)
                .join(', ')
            : undefined,
      })
  }
  items.sort((a, b) => a.atMs - b.atMs)
  return { stage, planReady: currentPlan, records, foreign, items, planningStarted: start }
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
