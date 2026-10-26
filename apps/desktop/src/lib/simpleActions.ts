import { projectStateOf, useStore } from '../store'
import { boundedSimple, replySequence, type SimpleEntry } from './simple'
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
    entry.sequence <= replySequence(simple, entry.sessionId, entry.generation)
  )
    return
  const complete = {
    ...entry,
    id: entry.id ?? crypto.randomUUID(),
    atMs: entry.atMs ?? Date.now(),
  } as SimpleEntry
  useStore.getState().patchTask(projectId, task, {
    simple: boundedSimple({
      ...simple,
      log: [...simple.log, complete].sort((a, b) => a.atMs - b.atMs),
    }),
  })
}
