import { useEffect } from 'react'
import { create } from 'zustand'
import { useStore, type FlowNode } from '../store'
import {
  activityRoots,
  componentActivity,
  liveComponents,
  LIVE_MS,
  type ActivityRoots,
  type RoleActivity,
} from './activity'

/**
 * Role agents' file activity on the visible map (Navigation and Chat): `active` pulses for ten
 * seconds, `roles` keeps what the retained activity shows per component.
 */
export const useMapActivity = create<{
  active: string[]
  roles: Record<string, RoleActivity[]>
}>(() => ({ active: [], roles: {} }))

const EMPTY: RoleActivity[] = []
export const rolesOf = (id: string) => (s: ReturnType<typeof useMapActivity.getState>) =>
  s.roles[id] ?? EMPTY

/** Same entries in the same state, so an unchanged tick doesn't re-render every node. */
const sameEntries = (a: RoleActivity[] | undefined, b: RoleActivity[]) =>
  !!a &&
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.sessionId === b[i].sessionId &&
      x.live === b[i].live &&
      x.lastMs === b[i].lastMs &&
      x.paths.length === b[i].paths.length &&
      x.paths.every((path, j) => path === b[i].paths[j]),
  )

/**
 * The map's component roots in `worktree`, normalized again only when a component's id or path
 * changes, not on every drag.
 */
let cached: { nodes: FlowNode[]; worktree: string; key: string; roots: ActivityRoots } | undefined
function rootsFor(nodes: FlowNode[], worktree: string) {
  if (cached?.nodes === nodes && cached.worktree === worktree) return cached.roots
  const key = JSON.stringify(nodes.map((n) => [n.id, n.data.path]))
  if (cached?.key !== key || cached.worktree !== worktree)
    cached = {
      nodes,
      worktree,
      key,
      roots: activityRoots(
        nodes.map((n) => ({ id: n.id, path: n.data.path })),
        worktree,
      ),
    }
  else cached.nodes = nodes
  return cached.roots
}

const worktreeOf = (s: ReturnType<typeof useStore.getState>, root: string) =>
  s.tasks.find((t) => t.id === s.activeTask)?.worktree ?? root

export function useMapActivityFeedback() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let roots: ActivityRoots | undefined
    const update = () => {
      clearTimeout(timer)
      timer = undefined
      const s = useStore.getState()
      if (!s.project) {
        // No project, no chips: the last one's mustn't linger.
        roots = undefined
        const previous = useMapActivity.getState()
        if (previous.active.length || Object.keys(previous.roles).length)
          useMapActivity.setState({ active: [], roles: {} })
        return
      }
      const worktree = worktreeOf(s, s.project.root)
      roots = rootsFor(s.nodes, worktree)
      const now = Date.now()
      const found = componentActivity(
        s.sessionRecords,
        s.sessions,
        s.project.id,
        s.activeTask,
        worktree,
        roots,
        now,
      )
      const previous = useMapActivity.getState()
      const roles: Record<string, RoleActivity[]> = {}
      let changed = Object.keys(previous.roles).some((id) => !found.has(id))
      let expires = Infinity
      for (const [id, entries] of found) {
        const kept = previous.roles[id]
        roles[id] = sameEntries(kept, entries) ? kept : entries
        if (roles[id] !== kept) changed = true
        for (const e of entries) if (e.live) expires = Math.min(expires, e.lastMs + LIVE_MS)
      }
      const active = liveComponents(found)
      if (changed || active.join('\0') !== previous.active.join('\0'))
        useMapActivity.setState({ active, roles: changed ? roles : previous.roles })
      // Only time passing ends a pulse; new activity arrives with the sessions.
      if (expires < Infinity) timer = setTimeout(update, Math.max(0, expires - now) + 50)
    }
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (
        s.sessions !== prev.sessions ||
        s.sessionRecords !== prev.sessionRecords ||
        s.activeTask !== prev.activeTask ||
        s.project !== prev.project ||
        s.tasks !== prev.tasks ||
        (s.nodes !== prev.nodes &&
          !!s.project &&
          rootsFor(s.nodes, worktreeOf(s, s.project.root)) !== roots)
      )
        update()
    })
    update()
    return () => {
      unsubscribe()
      clearTimeout(timer)
      useMapActivity.setState({ active: [], roles: {} })
    }
  }, [])
}
