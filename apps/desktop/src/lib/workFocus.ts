import { create } from 'zustand'
import { useStore } from '../store'
import type { Task } from '../types'
import { UNSETTLED_REQUESTS, type ChatTeam } from './chatTeams'

/**
 * Which work the side views show: one worktree (the focus, the store's `activeTask`) or All work,
 * every open worktree at once. The project's one lead works in all of them, so the Map, Stories,
 * Changes and Agents can show the whole picture. Per project and in memory, like other view
 * state; Chat and Navigation share it.
 */
export const useAllWork = create<{ projects: Record<string, boolean> }>(() => ({ projects: {} }))

export function setAllWork(projectId: string, on: boolean) {
  useAllWork.setState((s) => ({ projects: { ...s.projects, [projectId]: on } }))
}

/** Whether the current project shows All work. */
export function useAllWorkOn() {
  const projectId = useStore((s) => s.project?.id ?? '')
  return useAllWork((s) => !!s.projects[projectId])
}

/**
 * Focus one worktree from anywhere (a story, a map badge): leaves All work, unless the choice was
 * made from All work's own list, which stays to pick the next one.
 */
export function focusWork(task: string | null, { keepAllWork = false } = {}) {
  const s = useStore.getState()
  if (!s.project) return
  if (task && s.tasks.find((t) => t.id === task)?.missing) return
  if (!keepAllWork) setAllWork(s.project.id, false)
  // Exactly this worktree: the project folder never resolves to the checkout's current task.
  if (s.activeTask !== task) s.setActiveTask(task, true)
}

/** The open worktrees whose scope includes `component`, for the map's All work badges. */
export function worktreesOf(tasks: readonly Task[], component: string) {
  return tasks.filter((t) => !t.missing && t.components.includes(component))
}

/** Stories whose lead `startAuto` request is still under way, such as a backlog run's. */
export function leadStories(requests: ChatTeam['requests']) {
  return new Set(
    (requests ?? []).flatMap((r) =>
      r.action === 'startAuto' &&
      typeof r.settings.story === 'string' &&
      UNSETTLED_REQUESTS.includes(r.state)
        ? [r.settings.story]
        : [],
    ),
  )
}
