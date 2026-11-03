import { agentChatTask } from './agentChats'
import { projectStateOf, useStore, workspaceOf } from '../store'
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
  // Ingestion creates related conversations even if Chat has never been opened.
  if (metadata.componentId !== PLAN_SCOPE) {
    for (const task of [null, ...state.tasks.map((t) => t.id)]) {
      const worktree = state.tasks.find((t) => t.id === task)
      if (
        !all.get(task) &&
        relatedSession(
          r,
          {
            projectId: metadata.projectId,
            task,
            path: worktree?.worktree ?? state.project.root,
            branch: worktree?.branch,
          },
          generation,
        )
      )
        all.set(task, { startedMs: r.snapshot?.startedMs ?? 0, log: [] })
    }
  }
  const scopes: { task: string | null; simple: SimpleState }[] = []
  for (const [task, simple] of all) {
    if (!simple) continue
    const worktree = state.tasks.find((t) => t.id === task)
    const path = worktree?.worktree ?? state.project.root
    const branch = worktree?.branch
    if (metadata.componentId === '@map' && agentChatTask(r, generation) !== task) continue
    if (!relatedSession(r, { projectId: metadata.projectId, task, path, branch }, generation))
      continue
    // A project planner is shared; only chats that actually used this run receive its replies.
    if (metadata.componentId === PLAN_SCOPE && !ownsPlanner(simple, sid, generation)) continue
    scopes.push({ task, simple })
  }
  return { projectId: metadata.projectId, record: r, scopes }
}

/** Persist at ingestion, including snapshots, even while Chat is unmounted. */
export function persistReplies(
  sid: string,
  generation: number,
  incoming: readonly Reply[],
  record?: SessionRecord,
) {
  if (incoming.length) write(sid, generation, incoming, replyScopes(sid, generation, record))
}

/**
 * `persistReplies` for a caller that repeats it, e.g. every reconcile: writes only when the key
 * (the run, its replies' sequences, and the chats by start that receive them) differs from the
 * `previous` one it returned, and returns the current key.
 */
export function persistChangedReplies(
  sid: string,
  generation: number,
  replies: readonly Reply[],
  record: SessionRecord | undefined,
  previous: string | undefined,
) {
  const target = replyScopes(sid, generation, record)
  const key = JSON.stringify([
    generation,
    replies.map((r) => r.sequence),
    target?.scopes.map(({ task, simple }) => [task, simple.startedMs]),
  ])
  if (key !== previous && replies.length) write(sid, generation, replies, target)
  return key
}

function write(
  sid: string,
  generation: number,
  incoming: readonly Reply[],
  target: ReturnType<typeof replyScopes>,
) {
  if (!target) return
  for (const { task, simple } of target.scopes) {
    const state = projectStateOf(target.projectId)
    if (!state) return
    // Save the intended cutoff before logSimple can initialize it from the first reply.
    if (!workspaceOf(state, task).simple)
      useStore.getState().patchTask(target.projectId, task, { simple })
    for (const reply of [...incoming].sort((a, b) => a.sequence - b.sequence)) {
      if (reply.atMs < simple.startedMs) continue
      void logSimple(target.projectId, task, {
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
