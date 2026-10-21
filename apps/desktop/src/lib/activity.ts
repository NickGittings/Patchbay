import type { Activity, Component, SessionRecord, SessionState } from '../types'
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
/** Latest accepted file activity in the selected worktree, for the ten-second map pulse. */
export function activeComponents(
  records: readonly SessionRecord[],
  sessions: Record<string, SessionState>,
  projectId: string,
  task: string | null,
  worktree: string,
  components: readonly Pick<Component, 'id' | 'path'>[],
  now: number,
) {
  const ids = new Set<string>()
  for (const record of records) {
    if (
      record.metadata.projectId !== projectId ||
      (record.spec.cwd !== worktree && (record.metadata.task ?? null) !== task)
    )
      continue
    if (record.metadata.componentId === '@plan' && record.spec.cwd !== worktree) continue
    for (const activity of sessions[record.id]?.activity ?? []) {
      if (activity.atMs > now || now - activity.atMs > 10000) continue
      const file = activityFile(activity, record, components, worktree)
      if (file) ids.add(file.componentId)
    }
  }
  return ids
}
