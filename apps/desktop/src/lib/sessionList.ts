import type { SessionRecord } from '../types'

export type SessionFilter = 'all' | 'running' | 'closed'
export type SessionSort = 'latest' | 'oldest'
export interface SessionListOptions {
  filter: SessionFilter
  sort: SessionSort
}
export type ProjectSessionChoices = Partial<Record<string, SessionListOptions>>
export const DEFAULT_SESSION_LIST_OPTIONS: Readonly<SessionListOptions> = {
  filter: 'all',
  sort: 'latest',
}
export interface SessionRow {
  record: SessionRecord
  /** When the session last started or exited: both its sort key and its shown time. */
  time: number | undefined
}
export interface SessionGroup {
  projectId: string
  projectName: string
  records: SessionRecord[]
}

/** Latest valid `Date` time (±8.64e15 ms), so a corrupt one can't break `toISOString`. */
const MAX_DATE_MS = 8.64e15

/**
 * When the current run started or exited, or the newest such time across history when no snapshot
 * remains. Output times are left out on purpose: they move every reconcile while a session prints,
 * and rows must not shift under the cursor (nor show times out of order with their sort).
 */
export function sessionTimeMs(record: SessionRecord): number | undefined {
  const snapshots = record.snapshot ? [record.snapshot] : record.history
  let latest: number | undefined
  for (const snapshot of snapshots) {
    for (const time of [snapshot.startedMs, snapshot.exitedMs]) {
      if (
        time != null &&
        Number.isFinite(time) &&
        Math.abs(time) <= MAX_DATE_MS &&
        (latest === undefined || time > latest)
      )
        latest = time
    }
  }
  return latest
}

/** A session still starting (recorded, not yet spawned) counts as live, like a running one. */
export function sessionLive(record: SessionRecord): boolean {
  return record.snapshot ? record.snapshot.running : !record.interrupted
}

/** Records grouped by project, groups ordered by project name so they never swap on their own. */
export function groupByProject(records: readonly SessionRecord[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>()
  for (const record of records) {
    const { projectId, projectName } = record.metadata
    const group = groups.get(projectId)
    if (group) group.records.push(record)
    else groups.set(projectId, { projectId, projectName, records: [record] })
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.projectName.localeCompare(b.projectName) ||
      (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0),
  )
}

/** One project's visible rows; never mutates the records. */
export function projectSessions(
  records: readonly SessionRecord[],
  { filter, sort }: SessionListOptions,
): SessionRow[] {
  return records
    .filter((record) => filter === 'all' || sessionLive(record) === (filter === 'running'))
    .map((record) => ({ record, time: sessionTimeMs(record) }))
    .sort((a, b) => {
      if (a.time === undefined && b.time !== undefined) return 1
      if (b.time === undefined && a.time !== undefined) return -1
      if (a.time !== undefined && b.time !== undefined && a.time !== b.time)
        return sort === 'latest' ? b.time - a.time : a.time - b.time
      return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0
    })
}
