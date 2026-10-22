import { create } from 'zustand'
import { gitWorktrees } from './ipc'

export interface MainWorktree {
  /** Whether the project is in a Git repository, so tasks (worktrees) can be made. */
  git: boolean
  /** The main worktree's branch, or `detached <sha>`. */
  branch: string
}

/**
 * Each project's main worktree, read when its picker mounts or opens rather than on every Git
 * refresh (it only changes on a checkout), and shared so the worktree picker and Build agree.
 */
export const useMainWorktree = create<Record<string, MainWorktree>>(() => ({}))

const latest = new Map<string, number>()

/** Re-read `projectId`'s worktrees; only the newest request's answer is kept. */
export function refreshMainWorktree(projectId: string | undefined) {
  if (!projectId) return
  const request = (latest.get(projectId) ?? 0) + 1
  latest.set(projectId, request)
  const apply = (info: MainWorktree) => {
    if (latest.get(projectId) === request) useMainWorktree.setState({ [projectId]: info })
  }
  void gitWorktrees(projectId)
    .then((list) => {
      const current = list.find((w) => w.current)
      apply({
        git: list.length > 0,
        branch: current?.branch ?? (current ? `detached ${current.head.slice(0, 7)}` : ''),
      })
    })
    .catch(() => apply({ git: false, branch: '' }))
}
