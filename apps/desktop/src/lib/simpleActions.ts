import { projectStateOf, useStore } from '../store'
import { boundedSimple, type SimpleEntry } from './simple'
import { terminalSnapshot } from './ipc'

/**
 * The run an action entry names. The store may still hold a stopped run until the new one's
 * `started` event arrives, or nothing before hydration; the service already knows the current one.
 */
export async function currentRun(
  sid: string | undefined,
): Promise<{ generation?: number; startedMs?: number }> {
  if (!sid) return {}
  const snapshot = await terminalSnapshot(sid, 0).catch(() => null)
  const run = snapshot ?? useStore.getState().sessions[sid]
  return { generation: run?.generation, startedMs: run?.startedMs }
}
/** Completion always belongs to its originating worktree, even if the user moved on. */
export function logSimple(
  projectId: string,
  task: string | null,
  entry: SimpleEntry extends infer E
    ? E extends SimpleEntry
      ? Omit<E, 'id' | 'atMs'> & Partial<Pick<E, 'id' | 'atMs'>>
      : never
    : never,
) {
  const state = projectStateOf(projectId)
  if (!state) return
  const simple = (state.activeTask === task
    ? state.simple
    : state.taskWorkspaces[task ?? '']?.simple) ?? { startedMs: Date.now(), log: [] }
  if (
    entry.kind === 'reply' &&
    simple.log.some(
      (e) =>
        e.kind === 'reply' &&
        e.sessionId === entry.sessionId &&
        e.generation === entry.generation &&
        e.sequence === entry.sequence,
    )
  )
    return
  const complete = {
    ...entry,
    id: entry.id ?? crypto.randomUUID(),
    atMs: entry.atMs ?? Date.now(),
  } as SimpleEntry
  const next = boundedSimple({ ...simple, log: [...simple.log, complete] })
  if (next.log.length === simple.log.length && next.log.every((e, i) => e === simple.log[i])) return
  useStore.getState().patchTask(projectId, task, { simple: next })
}
