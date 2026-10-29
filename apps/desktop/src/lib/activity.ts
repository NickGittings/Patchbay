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
import { hydrateJournal } from './journal'
export const hydrateActivity = hydrateJournal('activity', 50)
/**
 * Commands and patch bodies are never file paths. Only known single-file tool targets link (core
 * names Codex's `read_file`/`write_file`/`edit_file` Read/Write/Edit, and `apply_patch` Edit with
 * the one file its headers name, `agent_hooks::patched_file`). The raw Codex names stay accepted:
 * an installed hook reporter is only replaced on reinstall, so older ones still send them.
 */
const WRITES = ['Edit', 'Write', 'MultiEdit', 'write_file', 'edit_file']
export const fileActivity = (activity: Activity) =>
  activity.fileTarget === true &&
  ['Read', 'read_file', ...WRITES].includes(activity.tool) &&
  !!activity.target
/** File activity that changes the file, which alone marks the map and file tree: reading a file isn't working on it. */
export const writeActivity = (activity: Activity) =>
  fileActivity(activity) && WRITES.includes(activity.tool)
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

/**
 * `file` relative to `base`, both normalized and absolute, with `../` for files outside it as
 * project paths name external components (`../billing/…`); another drive stays absolute.
 */
function relativeTo(file: string, base: string) {
  if (inside(file, base)) return file.slice(base.replace(/\/$/, '').length + 1)
  const from = base.split('/').filter(Boolean)
  const to = file.split('/').filter(Boolean)
  let common = 0
  while (common < from.length && common < to.length && from[common] === to[common]) common++
  if (!common && !(file.startsWith('/') && base.startsWith('/'))) return file
  return [...Array<string>(from.length - common).fill('..'), ...to.slice(common)].join('/')
}

/** Component roots in `worktree`, longest first, normalized once for many activities. */
export interface ActivityRoots {
  worktree: string
  components: { id: string; root: string }[]
}
export function activityRoots(
  components: readonly Pick<Component, 'id' | 'path'>[],
  worktree: string,
): ActivityRoots {
  // Relative component roots follow this session's worktree, not the project's original folder.
  return {
    worktree: normalizedPath(worktree),
    components: components
      .map((c) => ({
        id: c.id,
        root: normalizedPath(absolute(c.path) ? c.path : `${worktree}/${c.path}`),
      }))
      .sort((a, b) => b.root.length - a.root.length),
  }
}

/** The component and root-relative path of a file activity, as change lists name them. */
export function activityFile(
  activity: Activity,
  record: SessionRecord,
  components: readonly Pick<Component, 'id' | 'path'>[] | ActivityRoots,
  worktree: string,
) {
  if (!fileActivity(activity) || !activity.target) return undefined
  const roots = 'worktree' in components ? components : activityRoots(components, worktree)
  const cwd = record.spec.cwd
  const file = normalizedPath(
    absolute(activity.target) ? activity.target : `${cwd}/${activity.target}`,
  )
  // Patchbay's plans and findings, and Git's own files, under a `.git` folder aren't work on the
  // component that contains it.
  if (file.split('/').includes('.git')) return undefined
  const owner = roots.components.find((c) => inside(file, c.root))
  if (owner) return { componentId: owner.id, path: relativeTo(file, roots.worktree) }
  if (inside(file, roots.worktree))
    return { componentId: '@project', path: relativeTo(file, roots.worktree) }
  return undefined
}
/**
 * The newest write reported by hooks, resolved in the worktree's change-list coordinates, with its
 * time. With `listed`, only a file still in that change list counts: a write since committed or
 * reverted, or outside the change list, never names a file the list can't show.
 */
export function newestWrite(
  record: SessionRecord,
  session: Pick<SessionState, 'activity'> | undefined,
  components: readonly Pick<Component, 'id' | 'path'>[],
  worktree: string,
  listed?: readonly { componentId: string; path: string }[],
) {
  const writes = session?.activity
    ?.filter(writeActivity)
    .toSorted((a, b) => b.atMs - a.atMs || b.sequence - a.sequence)
  if (!writes?.length) return undefined
  const roots = activityRoots(components, worktree)
  for (const activity of writes) {
    const file = activityFile(activity, record, roots, worktree)
    if (!file) continue
    if (listed && !listed.some((l) => l.componentId === file.componentId && l.path === file.path))
      continue
    return { file, atMs: activity.atMs }
  }
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

/** Files one session wrote in a component: `live` while its newest is under ten seconds old. */
export interface RoleActivity {
  role: AgentRole
  sessionId: string
  /** The session's scope, for `revealTerminal`. */
  scope: string
  lastMs: number
  live: boolean
  paths: string[]
}

export const LIVE_MS = 10000

/** Accepted file writes in the selected worktree, per component and session. */
function* worktreeActivity(
  records: readonly SessionRecord[],
  sessions: Record<string, SessionState>,
  projectId: string,
  task: string | null,
  worktree: string,
  components: readonly Pick<Component, 'id' | 'path'>[] | ActivityRoots,
  now: number,
) {
  const roots = 'worktree' in components ? components : activityRoots(components, worktree)
  for (const record of records) {
    if (
      record.metadata.projectId !== projectId ||
      (record.spec.cwd !== worktree && (record.metadata.task ?? null) !== task)
    )
      continue
    if (record.metadata.componentId === PLAN_SCOPE && record.spec.cwd !== worktree) continue
    for (const activity of sessions[record.id]?.activity ?? []) {
      if (activity.atMs > now || !writeActivity(activity)) continue
      const file = activityFile(activity, record, roots, worktree)
      if (file) yield { record, activity, file }
    }
  }
}

/** Role agents' file writes per component, newest session first. */
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

/** Components of `componentActivity` a role agent touched in the last ten seconds, sorted. */
export function liveComponents(found: ReadonlyMap<string, readonly RoleActivity[]>) {
  return [...found]
    .filter(([, entries]) => entries.some((e) => e.live))
    .map(([id]) => id)
    .sort()
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
