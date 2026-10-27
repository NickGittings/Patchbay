import { projectStateOf, useStore } from '../store'
import { boundedSimple, type SimpleEntry } from './simple'
import { terminalSnapshot } from './ipc'

type Entry = SimpleEntry extends infer E
  ? E extends SimpleEntry
    ? Omit<E, 'id' | 'atMs'> & Partial<Pick<E, 'id' | 'atMs'>>
    : never
  : never

/**
 * Completion always belongs to its originating worktree, even if the user moved on. An entry
 * naming a session but not its run waits for the service to name the current one (the store may
 * still hold a stopped run until the new one's `started` event, or nothing before hydration), so
 * no caller can log a claim on a stale run; callers that know the run pass it. With `atRunStart`,
 * a looked-up entry is dated at its run's start, before that run's replies.
 */
export function logSimple(
  projectId: string,
  task: string | null,
  entry: Entry,
  options?: { atRunStart?: boolean },
): Promise<void> {
  if (entry.kind === 'reply' || !entry.sessionId || entry.generation !== undefined) {
    append(projectId, task, entry)
    return Promise.resolve()
  }
  const sid = entry.sessionId
  const atMs = entry.atMs ?? Date.now()
  return terminalSnapshot(sid, 0)
    .catch(() => null)
    .then((snapshot) => {
      const run = snapshot ?? useStore.getState().sessions[sid]
      append(projectId, task, {
        ...entry,
        generation: run?.generation,
        atMs: (options?.atRunStart && run?.startedMs) || atMs,
      })
    })
}

function append(projectId: string, task: string | null, entry: Entry) {
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
