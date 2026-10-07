import type { SessionRecord, TerminalSnapshot } from '../types'

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
  /** Latest start, output or exit time, shown as the row's relative time. */
  activity: number | undefined
}

function latestTime(record: SessionRecord, times: (s: TerminalSnapshot) => (number | null)[]) {
  const snapshots = record.snapshot ? [record.snapshot] : record.history
  let latest: number | undefined
  for (const snapshot of snapshots) {
    for (const time of times(snapshot)) {
      if (time != null && Number.isFinite(time) && (latest === undefined || time > latest))
        latest = time
    }
  }
  return latest
}

/** Current run activity, or the newest activity across history when no snapshot remains. */
export function sessionActivityMs(record: SessionRecord): number | undefined {
  return latestTime(record, (s) => [s.startedMs, s.status.lastOutputMs, s.exitedMs])
}

/**
 * The sort key: like `sessionActivityMs` but without output times, so rows only move when a
 * session starts or exits, never while a running one prints (which would shift buttons under the
 * cursor on every reconcile).
 */
export function sessionOrderMs(record: SessionRecord): number | undefined {
  return latestTime(record, (s) => [s.startedMs, s.exitedMs])
}

/** Records grouped by project, in the order each project first appears. */
export function groupByProject(records: readonly SessionRecord[]): Map<string, SessionRecord[]> {
  const groups = new Map<string, SessionRecord[]>()
  for (const record of records) {
    const group = groups.get(record.metadata.projectId)
    if (group) group.push(record)
    else groups.set(record.metadata.projectId, [record])
  }
  return groups
}

/** One project's visible rows; never mutates the records. */
export function projectSessions(
  records: readonly SessionRecord[],
  projectId: string,
  { filter, sort }: SessionListOptions,
): SessionRow[] {
  return records
    .filter(
      (record) =>
        record.metadata.projectId === projectId &&
        (filter === 'all' || Boolean(record.snapshot?.running) === (filter === 'running')),
    )
    .map((record) => ({ record, order: sessionOrderMs(record) }))
    .sort((a, b) => {
      if (a.order === undefined && b.order !== undefined) return 1
      if (b.order === undefined && a.order !== undefined) return -1
      if (a.order !== undefined && b.order !== undefined && a.order !== b.order)
        return sort === 'latest' ? b.order - a.order : a.order - b.order
      return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0
    })
    .map(({ record }) => ({ record, activity: sessionActivityMs(record) }))
}
