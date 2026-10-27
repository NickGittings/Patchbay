import { projectStateOf, useStore } from '../store'
import { PLAN_SCOPE, sessionMetadata, type Reply, type SessionRecord } from '../types'
import { logSimple } from './simpleActions'
import { ownsPlanner, relatedSession, recordStage, type SimpleState } from './simple'
import { hydrateJournal } from './journal'

export const hydrateReplies = hydrateJournal('replies', 20)

/**
 * The chats a session's replies belong in: its related worktrees' chats, and for the shared
 * planner only those that used this run.
 */
function replyScopes(sid: string, generation: number, record?: SessionRecord) {
  const metadata = record?.metadata ?? sessionMetadata.get(sid)
  if (!metadata) return
  const state = projectStateOf(metadata.projectId)
  if (!state?.project) return
  const r = record ?? useStore.getState().sessionRecords.find((r) => r.id === sid)
  if (!r) return
  const all = new Map(
    Object.entries(state.taskWorkspaces).map(([task, w]) => [task || null, w.simple]),
  )
  all.set(state.activeTask, state.simple)
  const scopes: { task: string | null; simple: SimpleState }[] = []
  for (const [task, simple] of all) {
    if (!simple) continue
    const worktree = state.tasks.find((t) => t.id === task)
    const path = worktree?.worktree ?? state.project.root
    const branch = worktree?.branch
    if (!relatedSession(r, { projectId: metadata.projectId, task, path, branch })) continue
    // A project planner is shared; only chats that actually used this run receive its replies.
    if (metadata.componentId === PLAN_SCOPE && !ownsPlanner(simple, sid, generation)) continue
    scopes.push({ task, simple })
  }
  return { projectId: metadata.projectId, record: r, scopes }
}

/**
 * What `persistReplies` would write, so a caller repeating it for unchanged replies can skip it:
 * the run, its replies' sequences, and the chats (by start) that receive them.
 */
export function repliesKey(
  sid: string,
  generation: number,
  replies: readonly Reply[],
  record?: SessionRecord,
) {
  const target = replyScopes(sid, generation, record)
  return JSON.stringify([
    generation,
    replies.map((r) => r.sequence),
    target?.scopes.map(({ task, simple }) => [task, simple.startedMs]),
  ])
}

/** Persist at ingestion, including snapshots, even while Chat is unmounted. */
export function persistReplies(
  sid: string,
  generation: number,
  incoming: readonly Reply[],
  record?: SessionRecord,
) {
  if (!incoming.length) return
  const target = replyScopes(sid, generation, record)
  if (!target) return
  for (const { task, simple } of target.scopes) {
    for (const reply of [...incoming].sort((a, b) => a.sequence - b.sequence)) {
      if (reply.atMs < simple.startedMs) continue
      logSimple(target.projectId, task, {
        kind: 'reply',
        stage: recordStage(target.record),
        sessionId: sid,
        generation,
        sequence: reply.sequence,
        text: reply.text,
        atMs: reply.atMs,
      })
    }
  }
}
