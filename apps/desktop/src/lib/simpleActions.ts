import { projectStateOf, useStore } from '../store'
import type { SimpleEntry } from './simple'
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
  useStore
    .getState()
    .patchTask(projectId, task, { simple: { ...simple, log: [...simple.log, complete] } })
}
