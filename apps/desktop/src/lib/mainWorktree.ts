import { create } from 'zustand'
import type { Worktree } from '../types'
import { gitWorktrees } from './ipc'
import { shortSha } from './commitId'

export interface MainWorktree {
  /** Whether the project is in a Git repository, so tasks (worktrees) can be made. */
  git: boolean
  /** The main worktree's branch, or `detached <sha>`. */
  branch: string
}

/**
 * Each project's main worktree: the one source for its branch label. Re-read when the Git
 * watcher sees a `HEAD` or ref change (an agent's checkout) and whenever a picker lists the
 * worktrees, so the footer label, branch menus, worktree picker and Build agree.
 */
export const useMainWorktree = create<Record<string, MainWorktree>>(() => ({}))

/** Each project's newest request, and whether it is still waiting for its answer. */
const latest = new Map<string, { request: number; pending: boolean }>()
let nextRequest = 0
/** Each project's branch refresh waiting for a burst of watcher signals to settle. */
const scheduled = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Record `listing`, a read of `projectId`'s worktrees, as the project's newest one. The request is
 * numbered now, before it answers, so only the newest read started applies: an older one that
 * answers later is ignored, as is any answer after the project closed. Returns `listing` for the
 * caller's own use; a failure is recorded as no Git repository.
 */
export function readMainWorktrees(projectId: string, listing: Promise<Worktree[]>) {
  const request = ++nextRequest
  latest.set(projectId, { request, pending: true })
  const apply = (info: MainWorktree) => {
    if (latest.get(projectId)?.request !== request) return
    latest.set(projectId, { request, pending: false })
    const known = useMainWorktree.getState()[projectId]
    if (known?.git === info.git && known.branch === info.branch) return
    useMainWorktree.setState({ [projectId]: info })
  }
  void listing.then(
    (list) => apply(describe(list)),
    () => apply({ git: false, branch: '' }),
  )
  return listing
}

/** Re-read `projectId`'s worktrees; only the newest request's answer is kept. */
export function refreshMainWorktree(projectId: string | undefined) {
  if (!projectId) return
  readMainWorktrees(projectId, gitWorktrees(projectId)).catch(() => {})
}

/**
 * Re-read `projectId`'s branches once a burst of watcher signals settles, running `also` (such as
 * a task list refresh) alongside. Closing the project cancels it.
 */
export function scheduleBranchRefresh(
  projectId: string,
  also?: (projectId: string) => void,
  delay = 250,
) {
  clearTimeout(scheduled.get(projectId))
  scheduled.set(
    projectId,
    setTimeout(() => {
      scheduled.delete(projectId)
      refreshMainWorktree(projectId)
      also?.(projectId)
    }, delay),
  )
}

/** Whether a branch refresh for `projectId` is waiting for its burst of signals to settle. */
export const branchRefreshScheduled = (projectId: string) => scheduled.has(projectId)

/** Cancel every scheduled branch refresh (the listener is going away). */
export function cancelBranchRefreshes() {
  for (const timer of scheduled.values()) clearTimeout(timer)
  scheduled.clear()
}

function describe(list: Worktree[]): MainWorktree {
  const current = list.find((w) => w.current)
  return {
    git: list.length > 0,
    branch: current?.branch ?? (current ? `detached ${shortSha(current.head)}` : ''),
  }
}

/** Read `projectId`'s worktrees unless they are known already or being read. */
export function ensureMainWorktree(projectId: string | undefined) {
  if (!projectId || useMainWorktree.getState()[projectId] || latest.get(projectId)?.pending) return
  refreshMainWorktree(projectId)
}

/**
 * Drop a closed project's entry and its scheduled refresh; a request still on its way is ignored
 * when it answers.
 */
export function forgetMainWorktree(projectId: string) {
  clearTimeout(scheduled.get(projectId))
  scheduled.delete(projectId)
  latest.delete(projectId)
  useMainWorktree.setState((m) => {
    if (!(projectId in m)) return m
    const { [projectId]: _closed, ...rest } = m
    return rest
  }, true)
}
