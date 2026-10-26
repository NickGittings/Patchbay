import { projectStateOf, useStore } from '../store'
import {
  PLAN_SCOPE,
  sessionMetadata,
  type Reply,
  type SessionRecord,
  type SessionState,
} from '../types'
import { logSimple } from './simpleActions'
import { relatedSession, recordStage } from './simple'

export function hydrateReplies(
  previous: SessionState | undefined,
  generation: number,
  incoming: readonly Reply[] = [],
): Reply[] {
  if ((previous?.generation ?? 0) > generation) return previous?.replies ?? []
  const replies =
    previous?.generation === generation ? [...(previous.replies ?? []), ...incoming] : [...incoming]
  return [...new Map(replies.map((r) => [r.sequence, r])).values()]
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-20)
}

/** The newest reply sequence persisted per session and generation, so repeats cost nothing. */
const persisted = new Map<string, { generation: number; sequence: number }>()

export function resetPersistedReplies() {
  persisted.clear()
}

/** Persist at ingestion, including snapshots, even while Chat is unmounted. */
export function persistReplies(
  sid: string,
  generation: number,
  incoming: readonly Reply[],
  record?: SessionRecord,
) {
  const mark = persisted.get(sid)
  const replies =
    mark?.generation === generation ? incoming.filter((r) => r.sequence > mark.sequence) : incoming
  if (!replies.length) return
  const s = useStore.getState()
  const metadata = record?.metadata ?? sessionMetadata.get(sid)
  if (!metadata) return
  const state = projectStateOf(metadata.projectId)
  if (!state?.project) return
  const r = record ?? s.sessionRecords.find((r) => r.id === sid)
  if (!r) return
  const scopes = new Map(
    Object.entries(state.taskWorkspaces).map(([task, w]) => [task || null, w.simple]),
  )
  scopes.set(state.activeTask, state.simple)
  for (const [task, simple] of scopes) {
    if (!simple) continue
    const path = state.tasks.find((t) => t.id === task)?.worktree ?? state.project.root
    if (!relatedSession(r, { projectId: metadata.projectId, task, path })) continue
    // A project planner is shared; only chats that actually used this run receive its replies.
    const ownsPlanner = simple.log.some(
      (e) => e.sessionId === sid && e.generation === generation && e.kind !== 'reply',
    )
    if (metadata.componentId === PLAN_SCOPE && !ownsPlanner) continue
    for (const reply of replies) {
      if (reply.atMs < simple.startedMs) continue
      logSimple(metadata.projectId, task, {
        kind: 'reply',
        stage: recordStage(r),
        sessionId: sid,
        generation,
        sequence: reply.sequence,
        text: reply.text,
        atMs: reply.atMs,
      })
    }
  }
  if ((mark?.generation ?? 0) <= generation)
    persisted.set(sid, {
      generation,
      sequence: Math.max(
        mark?.generation === generation ? mark.sequence : 0,
        ...replies.map((r) => r.sequence),
      ),
    })
}
