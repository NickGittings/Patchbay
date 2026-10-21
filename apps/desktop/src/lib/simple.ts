import type { AutoRun, PlanText, Review, SessionRecord, SessionState } from '../types'
import { MERGE_SCOPE, PLAN_SCOPE, REVIEW_SCOPE } from '../types'
import { sessionTimeMs } from './sessionList'

export const SIMPLE_STAGES = ['plan', 'build', 'review', 'merge'] as const
export type SimpleStage = (typeof SIMPLE_STAGES)[number]
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
    | {
        kind: 'action'
        action: 'implement' | 'review' | 'fix' | 'merge' | 'validate' | 'autopilot' | 'resume'
        request?: import('../types').MergeRequest
      }
  )
export interface SimpleState {
  startedMs: number
  log: SimpleEntry[]
}

/** Old layouts start empty. Never truncate the worktree's action history. */
export function restoredSimple(value: unknown): SimpleState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as SimpleState
  if (!Number.isFinite(state.startedMs) || !Array.isArray(state.log)) return null
  const seen = new Set<string>()
  return {
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
          : entry.kind === 'action' &&
            ['implement', 'review', 'fix', 'merge', 'validate', 'autopilot', 'resume'].includes(
              entry.action,
            )
      if (valid) seen.add(entry.id)
      return valid
    }),
  }
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

/** Pure projection: stable sections and cards, never terminal-text interpretation or IPC. */
export function thread(snapshot: SimpleSnapshot, worktree: SimpleWorktree) {
  const records = snapshot.records
    .filter((r) => relatedSession(r, worktree))
    .sort((a, b) => (sessionTimeMs(a) ?? 0) - (sessionTimeMs(b) ?? 0) || a.id.localeCompare(b.id))
  const log = [...(snapshot.simple?.log ?? [])].sort((a, b) => a.atMs - b.atMs)
  let stage: SimpleStage = recordStageOrPlan(records.at(-1))
  const action = log
    .filter(
      (e) => e.kind === 'action' && ['implement', 'review', 'fix', 'merge'].includes(e.action),
    )
    .at(-1)
  const latestRecord = records.at(-1)
  if (
    action?.kind === 'action' &&
    action.atMs >= (latestRecord ? (sessionTimeMs(latestRecord) ?? 0) : 0)
  )
    stage = action.action === 'review' ? 'review' : action.action === 'merge' ? 'merge' : 'build'
  if (snapshot.auto && !['stopped', 'failed', 'done'].includes(snapshot.auto.status)) {
    const autoStage = snapshot.auto.stage
    stage =
      autoStage === 'plan'
        ? 'plan'
        : ['merge', 'mergeGate', 'done'].includes(autoStage)
          ? 'merge'
          : autoStage === 'review'
            ? 'review'
            : 'build'
  }
  return {
    stage,
    planReady: !!(snapshot.plan?.text.trim() || snapshot.proposal),
    sections: SIMPLE_STAGES.map((id) => ({
      id,
      entries: log.filter((e) => e.stage === id),
      sessions: records.filter((r) => recordStage(r) === id),
    })),
    records,
  }
}
const recordStageOrPlan = (record: SessionRecord | undefined): SimpleStage =>
  record ? recordStage(record) : 'plan'

/** An explicit recipient survives stage changes while it remains eligible. */
export function selectRecipient(
  records: readonly SessionRecord[],
  sessions: Record<string, SessionState>,
  stage: SimpleStage,
  override?: string,
) {
  const eligible = records.filter((r) => r.metadata.kind === 'agent')
  const explicit = eligible.find((r) => r.id === override)
  if (explicit) return explicit
  const stageRecords = eligible.filter((r) => recordStage(r) === stage)
  return (
    [...stageRecords].reverse().find((r) => sessions[r.id]?.running ?? r.snapshot?.running) ??
    stageRecords.at(-1)
  )
}
