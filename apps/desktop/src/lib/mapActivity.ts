import { useEffect } from 'react'
import { create } from 'zustand'
import { useStore } from '../store'
import { componentActivity, type RoleActivity } from './activity'

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
      x.paths.length === b[i].paths.length,
  )

export function useMapActivityFeedback() {
  useEffect(() => {
    const update = () => {
      const s = useStore.getState()
      if (!s.project) return
      const worktree = s.tasks.find((t) => t.id === s.activeTask)?.worktree ?? s.project.root
      const found = componentActivity(
        s.sessionRecords,
        s.sessions,
        s.project.id,
        s.activeTask,
        worktree,
        s.nodes.map((n) => ({ id: n.id, path: n.data.path })),
        Date.now(),
      )
      const previous = useMapActivity.getState()
      const roles: Record<string, RoleActivity[]> = {}
      let changed = Object.keys(previous.roles).some((id) => !found.has(id))
      for (const [id, entries] of found) {
        const kept = previous.roles[id]
        roles[id] = sameEntries(kept, entries) ? kept : entries
        if (roles[id] !== kept) changed = true
      }
      const active = [...found]
        .filter(([, entries]) => entries.some((e) => e.live))
        .map(([id]) => id)
        .sort()
      if (changed || active.join('\0') !== previous.active.join('\0'))
        useMapActivity.setState({ active, roles: changed ? roles : previous.roles })
    }
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (
        s.sessions !== prev.sessions ||
        s.sessionRecords !== prev.sessionRecords ||
        s.activeTask !== prev.activeTask ||
        s.project !== prev.project
      )
        update()
    })
    update()
    const timer = setInterval(update, 1000)
    return () => {
      unsubscribe()
      clearInterval(timer)
      useMapActivity.setState({ active: [], roles: {} })
    }
  }, [])
}
