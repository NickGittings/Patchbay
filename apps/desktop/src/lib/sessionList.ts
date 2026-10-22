import {
  MAP_SCOPE,
  PLAN_SCOPE,
  REVIEW_SCOPE,
  MERGE_SCOPE,
  isReservedScope,
  type SessionRecord,
  type Task,
} from '../types'

type SessionMetadata = SessionRecord['metadata']
export interface SessionRole {
  role: string
  tone: 'plan' | 'implement' | 'review' | 'merge' | 'task' | 'shell'
}

/** The purpose of a session, independent of its terminal's saved name. */
export function sessionRole(metadata: SessionMetadata): SessionRole {
  if (metadata.extensionId) return { role: 'Extension', tone: 'task' }
  if (metadata.kind === 'shell') return { role: 'Shell', tone: 'shell' }
  switch (metadata.componentId) {
    case PLAN_SCOPE:
      return { role: 'Planner', tone: 'plan' }
    case REVIEW_SCOPE:
      return { role: 'Review', tone: 'review' }
    case MERGE_SCOPE:
      return { role: 'Merge', tone: 'merge' }
    case MAP_SCOPE:
      return { role: 'Dependencies', tone: 'plan' }
    default:
      // Root terminals and component terminals alike: agents implement, the rest run tasks.
      return metadata.kind === 'agent'
        ? { role: 'Build', tone: 'implement' }
        : { role: 'Task', tone: 'task' }
  }
}

/** Component sessions name their component; reviews name the branch being reviewed. */
export function subject(metadata: SessionMetadata): string | undefined {
  if (metadata.componentId === REVIEW_SCOPE) return metadata.branch ?? undefined
  return isReservedScope(metadata.componentId) ? undefined : metadata.componentId
}

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
export interface WorktreeSessionGroup {
  task: string | null
  title: string
  path: string | undefined
  branch: string | undefined
  rows: SessionRow[]
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const newestRow = (rows: readonly SessionRow[]) =>
  rows.reduce((a, b) => {
    const aTime = a.time ?? -Infinity
    const bTime = b.time ?? -Infinity
    return bTime > aTime || (bTime === aTime && compareIds(b.record.id, a.record.id) < 0) ? b : a
  })

/** Group the full project history before filtering, so labels and paths stay stable. */
export function groupByWorktree(
  records: readonly SessionRecord[],
  options: SessionListOptions,
  tasks: readonly Task[] = [],
): WorktreeSessionGroup[] {
  const knownTasks = new Map(tasks.map((task) => [task.id, task]))
  const groups = new Map<string | null, WorktreeSessionGroup>()
  for (const row of projectSessions(records, { ...options, filter: 'all' })) {
    const id = row.record.metadata.task ?? null
    const group = groups.get(id)
    if (group) group.rows.push(row)
    else groups.set(id, { task: id, title: '', path: undefined, branch: undefined, rows: [row] })
  }
  for (const group of groups.values()) {
    // Folder moves and mixed legacy records must not make the displayed sort choose the path.
    group.path = newestRow(group.rows).record.metadata.projectRoot
    if (group.task === null) group.title = 'Main worktree'
    else {
      group.branch = knownTasks.get(group.task)?.branch
      const named = group.rows.filter((row) => row.record.metadata.taskTitle)
      // Cached/read-only task lists support records saved before taskTitle was introduced.
      group.title =
        (named.length ? newestRow(named).record.metadata.taskTitle : undefined) ??
        knownTasks.get(group.task)?.title ??
        `Worktree · ${group.path.split(/[\\/]/).filter(Boolean).at(-1) ?? group.path}`
    }
    group.rows = group.rows.filter(({ record }) => matchesFilter(record, options.filter))
  }
  return [...groups.values()]
    .filter((group) => group.rows.length)
    .sort((a, b) => {
      if (a.task === null) return -1
      if (b.task === null) return 1
      return a.title.localeCompare(b.title) || compareIds(a.task, b.task)
    })
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

/**
 * How many of a project's recorded sessions are running: this window's live state first, else
 * the record's own liveness. Close's confirmation and the Project panel's count agree on it.
 */
export function runningInProject(
  records: readonly SessionRecord[],
  sessions: Readonly<Record<string, { running: boolean } | undefined>>,
  projectId: string,
): number {
  return records.filter(
    (record) =>
      record.metadata.projectId === projectId &&
      (sessions[record.id]?.running ?? sessionLive(record)),
  ).length
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
    (a, b) => a.projectName.localeCompare(b.projectName) || compareIds(a.projectId, b.projectId),
  )
}

const matchesFilter = (record: SessionRecord, filter: SessionFilter): boolean =>
  filter === 'all' || sessionLive(record) === (filter === 'running')

/** One project's visible rows; never mutates the records. */
export function projectSessions(
  records: readonly SessionRecord[],
  { filter, sort }: SessionListOptions,
): SessionRow[] {
  return records
    .filter((record) => matchesFilter(record, filter))
    .map((record) => ({ record, time: sessionTimeMs(record) }))
    .sort((a, b) => {
      if (a.time === undefined && b.time !== undefined) return 1
      if (b.time === undefined && a.time !== undefined) return -1
      if (a.time !== undefined && b.time !== undefined && a.time !== b.time)
        return sort === 'latest' ? b.time - a.time : a.time - b.time
      return compareIds(a.record.id, b.record.id)
    })
}
