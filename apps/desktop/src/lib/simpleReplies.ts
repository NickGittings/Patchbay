import { projectStateOf, useStore } from '../store'
import { PLAN_SCOPE, sessionMetadata, type Reply, type SessionRecord } from '../types'
import { logSimple } from './simpleActions'
import { ownsPlanner, relatedSession, recordStage } from './simple'
import { hydrateJournal } from './journal'

export const hydrateReplies = hydrateJournal('replies', 20)

/** Persist at ingestion, including snapshots, even while Chat is unmounted. */
export function persistReplies(
  sid: string,
  generation: number,
  incoming: readonly Reply[],
  record?: SessionRecord,
) {
  if (!incoming.length) return
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
    const worktree = state.tasks.find((t) => t.id === task)
    const path = worktree?.worktree ?? state.project.root
    const branch = worktree?.branch
    if (!relatedSession(r, { projectId: metadata.projectId, task, path, branch })) continue
    // A project planner is shared; only chats that actually used this run receive its replies.
    if (metadata.componentId === PLAN_SCOPE && !ownsPlanner(simple, sid, generation)) continue
    for (const reply of [...incoming].sort((a, b) => a.sequence - b.sequence)) {
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
}
