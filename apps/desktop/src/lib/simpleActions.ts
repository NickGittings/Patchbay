import { projectStateOf, useStore } from '../store'
import { boundedSimple, type SimpleEntry } from './simple'
import { terminalSnapshot } from './ipc'

type Entry = SimpleEntry extends infer E
  ? E extends SimpleEntry
    ? Omit<E, 'id' | 'atMs'> & Partial<Pick<E, 'id' | 'atMs'>>
    : never
  : never

type Run = { generation?: number; startedMs?: number } | null | undefined
/** A run is this launch's only if it started once the launch began: never a stopped or older one. */
const launchedRun = (run: Run, launchedAtMs: number) =>
  run?.generation !== undefined && (run.startedMs ?? -Infinity) >= launchedAtMs ? run : undefined

/**
 * Log an action that started or resumed `entry.sessionId` at `launchedAtMs`, claiming the run only
 * when an authoritative source names it: the entry's own generation (a launch that reported it),
 * else a run the store or then the service holds that started since the launch. Without one the
 * entry names no run rather than a guess. With `atRunStart`, it is dated at its run's start,
 * before that run's replies.
 */
export async function logLaunch(
  projectId: string,
  task: string | null,
  entry: Extract<Entry, { kind: 'action' }>,
  launchedAtMs: number,
  options?: { atRunStart?: boolean },
) {
  const sid = entry.sessionId
  let run: Run = entry.generation === undefined ? undefined : entry
  if (!run && sid)
    run =
      launchedRun(useStore.getState().sessions[sid], launchedAtMs) ??
      launchedRun(await terminalSnapshot(sid, 0).catch(() => null), launchedAtMs)
  logSimple(projectId, task, {
    ...entry,
    generation: run?.generation,
    atMs: entry.atMs ?? (options?.atRunStart ? run?.startedMs : undefined),
  })
}

/** Completion always belongs to its originating worktree, even if the user moved on. */
export function logSimple(projectId: string, task: string | null, entry: Entry) {
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
