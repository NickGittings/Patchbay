import { create } from 'zustand'
import type { Worktree } from '../types'
import { gitWorktrees } from './ipc'

export interface MainWorktree {
  /** Whether the project is in a Git repository, so tasks (worktrees) can be made. */
  git: boolean
  /** The main worktree's branch, or `detached <sha>`. */
  branch: string
}

/**
 * Each project's main worktree: the one source for its branch label. Re-read on Git watcher
 * signals (an agent's checkout changes `HEAD`) and whenever a picker lists the worktrees, so the
 * footer label, branch menu, worktree picker and Build agree.
 */
export const useMainWorktree = create<Record<string, MainWorktree>>(() => ({}))

/** Each project's newest request, and whether it is still waiting for its answer. */
const latest = new Map<string, { request: number; pending: boolean }>()
let nextRequest = 0

/** Re-read `projectId`'s worktrees; only the newest request's answer is kept. */
export function refreshMainWorktree(projectId: string | undefined) {
  if (!projectId) return
  const request = ++nextRequest
  latest.set(projectId, { request, pending: true })
  const apply = (info: MainWorktree) => {
    if (latest.get(projectId)?.request !== request) return
    latest.set(projectId, { request, pending: false })
    useMainWorktree.setState({ [projectId]: info })
  }
  void gitWorktrees(projectId)
    .then((list) => apply(describe(list)))
    .catch(() => apply({ git: false, branch: '' }))
}

/**
 * Record worktrees `projectId` just listed elsewhere (such as the branch menu). It supersedes
 * reads still on their way, so an older answer cannot overwrite it.
 */
export function applyMainWorktrees(projectId: string, list: Worktree[]) {
  latest.set(projectId, { request: ++nextRequest, pending: false })
  useMainWorktree.setState({ [projectId]: describe(list) })
}

function describe(list: Worktree[]): MainWorktree {
  const current = list.find((w) => w.current)
  return {
    git: list.length > 0,
    branch: current?.branch ?? (current ? `detached ${current.head.slice(0, 7)}` : ''),
  }
}

/** Read `projectId`'s worktrees unless they are known already or being read. */
export function ensureMainWorktree(projectId: string | undefined) {
  if (!projectId || useMainWorktree.getState()[projectId] || latest.get(projectId)?.pending) return
  refreshMainWorktree(projectId)
}

/** Drop a closed project's entry; a request still on its way is ignored when it answers. */
export function forgetMainWorktree(projectId: string) {
  latest.delete(projectId)
  useMainWorktree.setState((m) => {
    if (!(projectId in m)) return m
    const { [projectId]: _closed, ...rest } = m
    return rest
  }, true)
}
