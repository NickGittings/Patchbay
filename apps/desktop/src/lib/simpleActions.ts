import { projectStateOf, useStore } from '../store'
import { boundedSimple, type SimpleEntry } from './simple'
import { sessionsList } from './ipc'
import { sessionFromSnapshot } from './sessionState'
import type { SessionRecord } from '../types'

type Entry = SimpleEntry extends infer E
  ? E extends SimpleEntry
    ? Omit<E, 'id' | 'atMs'> & Partial<Pick<E, 'id' | 'atMs'>>
    : never
  : never

type Run = { generation?: number; startedMs?: number } | null | undefined

/**
 * The run launch `requestId` started in `sid`: the run of the record whose latest request it is,
 * so never one from before the launch or one a later launch started. Reads the store's records,
 * else the service's list, whose newer run it also applies to the store, so a reconciliation that
 * failed after the launch never leaves the settled run there. Undefined while no record names it.
 */
export async function launchedRun(sid: string, requestId: string) {
  const ours = (records: readonly SessionRecord[]) =>
    records.find((r) => r.id === sid && !!r.snapshot && r.requestIds?.at(-1) === requestId)
  let record = ours(useStore.getState().sessionRecords)
  if (!record) {
    record = ours(await sessionsList().catch(() => []))
    const known = useStore.getState().sessions[sid]
    if (record?.snapshot && record.snapshot.generation > (known?.generation ?? -1))
      useStore.getState().setSession(sid, sessionFromSnapshot(known, record.snapshot, record))
  }
  return record?.snapshot
    ? { generation: record.snapshot.generation, startedMs: record.snapshot.startedMs }
    : undefined
}

/**
 * Log an action that started or resumed `entry.sessionId` with launch request `requestId`,
 * claiming the run only when one is known to be that launch's: the entry's own generation, else
 * the run `launchedRun` finds. Without one the entry names no run rather than a guess. With
 * `atRunStart`, it is dated at its run's start, before that run's replies.
 */
export async function logLaunch(
  projectId: string,
  task: string | null,
  entry: Extract<Entry, { kind: 'action' }>,
  requestId: string | undefined,
  options?: { atRunStart?: boolean },
) {
  const sid = entry.sessionId
  const run: Run =
    entry.generation !== undefined
      ? entry
      : sid && requestId
        ? await launchedRun(sid, requestId)
        : undefined
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
