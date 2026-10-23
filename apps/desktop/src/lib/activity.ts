import {
  MAP_SCOPE,
  MERGE_SCOPE,
  PLAN_SCOPE,
  REVIEW_SCOPE,
  TASK_ROOT_SCOPE,
  type Activity,
  type Component,
  type SessionRecord,
  type SessionState,
  type Task,
} from '../types'
/** Merge snapshots and live events by journal identity, independent of response order. */
export function hydrateActivity(
  previous: SessionState | undefined,
  generation: number,
  incoming: readonly Activity[] = [],
): Activity[] {
  if (previous?.generation !== undefined && previous.generation > generation)
    return previous.activity ?? []
  const events =
    previous?.generation === generation
      ? [...(previous.activity ?? []), ...incoming]
      : [...incoming]
  return [...new Map(events.map((a) => [a.sequence, a])).values()]
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-50)
}
/** Commands and patch bodies are never file paths. Only known single-file tool targets link. */
export const fileActivity = (activity: Activity) =>
  activity.fileTarget === true &&
  ['Read', 'Edit', 'Write', 'MultiEdit', 'read_file', 'write_file', 'edit_file'].includes(
    activity.tool,
  ) &&
  !!activity.target
const absolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
export function normalizedPath(path: string) {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '.' || !part) continue
    if (part === '..') {
      if (parts.length && parts.at(-1) !== '..') parts.pop()
      else if (!absolute(path)) parts.push(part)
    } else parts.push(part)
  }
  return (path.startsWith('/') ? '/' : '') + parts.join('/')
}
const inside = (file: string, dir: string) =>
  file === dir || file.startsWith(`${dir.replace(/\/$/, '')}/`)
export function activityFile(
  activity: Activity,
  record: SessionRecord,
  components: readonly Pick<Component, 'id' | 'path'>[],
  worktree: string,
) {
  if (!fileActivity(activity) || !activity.target) return undefined
  const cwd = record.spec.cwd
  const file = normalizedPath(
    absolute(activity.target) ? activity.target : `${cwd}/${activity.target}`,
  )
  // Relative component roots follow this session's worktree, not the project's original folder.
  const roots = components
    .map((c) => ({
      id: c.id,
      root: normalizedPath(absolute(c.path) ? c.path : `${worktree}/${c.path}`),
    }))
    .filter((c) => inside(file, c.root))
    .sort((a, b) => b.root.length - a.root.length)
  if (roots[0])
    return {
      componentId: roots[0].id,
      path: inside(file, normalizedPath(worktree))
        ? file.slice(normalizedPath(worktree).length + 1)
        : file,
    }
  if (inside(file, normalizedPath(worktree)))
    return { componentId: '@project', path: file.slice(normalizedPath(worktree).length + 1) }
  return undefined
}
/** Which role agent a session is, for the map's chips; `null` for scopes that don't work on files. */
export type AgentRole = 'plan' | 'build' | 'fix' | 'review' | 'merge'
export function agentRole(record: SessionRecord): AgentRole | null {
  const scope = record.metadata.componentId
  if (scope === PLAN_SCOPE) return 'plan'
  if (scope === REVIEW_SCOPE) return 'review'
  if (scope === MERGE_SCOPE) return 'merge'
  if (scope === TASK_ROOT_SCOPE) return record.metadata.branch ? 'fix' : 'build'
  if (scope === MAP_SCOPE) return null
  return 'build'
}

/** Files one session touched in a component: `live` while its newest is under ten seconds old. */
export interface RoleActivity {
  role: AgentRole
  sessionId: string
  /** The session's scope, for `revealTerminal`. */
  scope: string
  lastMs: number
  live: boolean
  paths: string[]
}

const LIVE_MS = 10000

/** Accepted file activity in the selected worktree, per component and session. */
function* worktreeActivity(
  records: readonly SessionRecord[],
  sessions: Record<string, SessionState>,
  projectId: string,
  task: string | null,
  worktree: string,
  components: readonly Pick<Component, 'id' | 'path'>[],
  now: number,
) {
  for (const record of records) {
    if (
      record.metadata.projectId !== projectId ||
      (record.spec.cwd !== worktree && (record.metadata.task ?? null) !== task)
    )
      continue
    if (record.metadata.componentId === PLAN_SCOPE && record.spec.cwd !== worktree) continue
    for (const activity of sessions[record.id]?.activity ?? []) {
      if (activity.atMs > now) continue
      const file = activityFile(activity, record, components, worktree)
      if (file) yield { record, activity, file }
    }
  }
}

/** Latest accepted file activity in the selected worktree, for the ten-second map pulse. */
export function activeComponents(...args: Parameters<typeof worktreeActivity>) {
  const now = args[6]
  const ids = new Set<string>()
  for (const { activity, file } of worktreeActivity(...args))
    if (now - activity.atMs <= LIVE_MS) ids.add(file.componentId)
  return ids
}

/** Role agents' file activity per component, newest session first. */
export function componentActivity(...args: Parameters<typeof worktreeActivity>) {
  const now = args[6]
  const byComponent = new Map<string, Map<string, RoleActivity>>()
  for (const { record, activity, file } of worktreeActivity(...args)) {
    const role = agentRole(record)
    if (!role) continue
    const entries = byComponent.get(file.componentId) ?? new Map<string, RoleActivity>()
    byComponent.set(file.componentId, entries)
    const entry = entries.get(record.id) ?? {
      role,
      sessionId: record.id,
      scope: record.metadata.componentId,
      lastMs: 0,
      live: false,
      paths: [],
    }
    entries.set(record.id, entry)
    entry.lastMs = Math.max(entry.lastMs, activity.atMs)
    entry.live = now - entry.lastMs <= LIVE_MS
    if (!entry.paths.includes(file.path)) entry.paths.push(file.path)
  }
  return new Map(
    [...byComponent].map(([id, entries]) => [
      id,
      [...entries.values()].sort((a, b) => b.lastMs - a.lastMs),
    ]),
  )
}

/** Review/merge/planner scopes run at a worktree root; component sessions also retain that root. */
export function activityRoot(record: SessionRecord, tasks: readonly Task[], fallback: string) {
  if ([PLAN_SCOPE, REVIEW_SCOPE, MERGE_SCOPE].includes(record.metadata.componentId))
    return record.spec.cwd
  return (
    tasks.find((task) => task.id === record.metadata.task)?.worktree ??
    record.metadata.projectRoot ??
    fallback
  )
}
