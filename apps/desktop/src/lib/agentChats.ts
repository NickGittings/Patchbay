import { projectStateOf, useStore, workspaceOf } from '../store'
import type { SessionRecord } from '../types'

// In-flight launches already own their replies before the start RPC returns a generation.
const pending = new Map<string, { task: string | null; afterGeneration: number }>()

export function beginAgentChat(sid: string, task: string | null, afterGeneration = -1) {
  pending.set(sid, { task, afterGeneration })
}

export function endAgentChat(sid: string) {
  pending.delete(sid)
}

/** Retained project-wide runs without an owner belong to the root conversation. */
export function agentChatTask(record: SessionRecord, generation = record.snapshot?.generation) {
  const state = projectStateOf(record.metadata.projectId)
  if (!state) return null
  const workspaces = new Map(Object.entries(state.taskWorkspaces))
  workspaces.set(state.activeTask ?? '', {
    ...workspaceOf(state, state.activeTask),
    simple: state.simple,
  })
  for (const [task, workspace] of workspaces) {
    if (
      workspace.simple?.agentRuns?.some(
        (r) => r.sessionId === record.id && r.generation === generation,
      )
    )
      return task || null
  }
  const launch = pending.get(record.id)
  if (launch && generation !== undefined && generation > launch.afterGeneration) return launch.task
  return null
}

export function claimAgentChat(
  projectId: string,
  task: string | null,
  sessionId: string,
  generation: number,
  startedMs = Date.now(),
) {
  const state = projectStateOf(projectId)
  if (!state) return
  const workspaces = [state.simple, ...Object.values(state.taskWorkspaces).map((w) => w.simple)]
  if (
    workspaces.some((s) =>
      s?.agentRuns?.some((r) => r.sessionId === sessionId && r.generation === generation),
    )
  )
    return
  const simple = workspaceOf(state, task).simple ?? { startedMs, log: [] }
  const agentRuns = simple.agentRuns ?? []
  if (agentRuns.some((r) => r.sessionId === sessionId && r.generation === generation)) return
  useStore.getState().patchTask(projectId, task, {
    simple: { ...simple, agentRuns: [...agentRuns, { sessionId, generation }] },
  })
}
