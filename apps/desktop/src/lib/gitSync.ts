import { useEffect } from 'react'
import { create } from 'zustand'
import { useStore } from '../store'
import type { SyncAction, SyncStatus } from '../types'
import { confirmAction } from './confirm'
import { componentPaths, requestGitRefresh } from './git'
import { historyRequest, type HistorySelection } from './history'
import { gitSync, gitSyncStatus } from './ipc'
import { useMainWorktree } from './mainWorktree'
import { simpleKey, useSimpleUi } from './simpleUi'
import { sessionLive } from './sessionList'
import { activeWorktree, refreshTasks } from './tasks'

/** Fetch on opening the Git panel at most this often. */
export const AUTO_FETCH_MS = 60_000

/** One repository of one worktree: `worktree` is `undefined` for the open one. */
export interface SyncScope {
  projectId: string
  worktree?: string
  repo: string
}

export interface SyncEntry {
  status?: SyncStatus
  busy?: SyncAction
  error?: string
}

export const syncKey = (scope: SyncScope) =>
  JSON.stringify([scope.projectId, scope.worktree ?? null, scope.repo])

/** Each scope's latest status, the action it is running, and its last error. */
export const useGitSync = create<Record<string, SyncEntry>>(() => ({}))

const patch = (key: string, entry: Partial<SyncEntry>) =>
  useGitSync.setState((s) => ({ [key]: { ...s[key], ...entry } }))

/** Per scope, bumped by each request so an older reply never overwrites a newer one. */
const requests = new Map<string, number>()
const nextRequest = (key: string) => {
  const id = (requests.get(key) ?? 0) + 1
  requests.set(key, id)
  return id
}

/** Read the scope's status from local refs. Failures keep the last status and record the error. */
export async function refreshSyncStatus(scope: SyncScope) {
  const key = syncKey(scope)
  const id = nextRequest(key)
  try {
    const status = await gitSyncStatus(componentPaths(), scope.repo, scope.worktree)
    if (requests.get(key) === id) patch(key, { status, error: undefined })
  } catch (e) {
    if (requests.get(key) === id) patch(key, { error: String(e) })
  }
}

/** Sessions of `projectId` running in `task`'s worktree (`null` for the project's own). */
export function runningInWorktree(projectId: string, task: string | null) {
  const { sessionRecords, sessions } = useStore.getState()
  return sessionRecords.filter(
    (r) =>
      r.metadata.projectId === projectId &&
      (r.metadata.task ?? null) === task &&
      (sessions[r.id]?.running ?? sessionLive(r)),
  ).length
}

const DONE: Record<SyncAction, string> = {
  fetch: 'Fetched',
  pull: 'Pulled',
  push: 'Pushed',
}

/**
 * Fetch, fast-forward pull, or push the scope's current branch. A pull that would change files
 * under running terminals or agents asks first. Returns whether the action ran and succeeded.
 */
export async function runSync(
  scope: SyncScope,
  action: SyncAction,
  { quiet = false, task = null }: { quiet?: boolean; task?: string | null } = {},
) {
  const key = syncKey(scope)
  if (useGitSync.getState()[key]?.busy) return false
  if (action === 'pull') {
    const running = runningInWorktree(scope.projectId, task)
    if (
      running > 0 &&
      !(await confirmAction({
        title: 'Pull while agents run',
        message: `${running} terminal${running === 1 ? ' is' : 's are'} running in this worktree. Pulling can change files under ${running === 1 ? 'it' : 'them'}. Pull anyway?`,
        detail: scope.worktree ?? scope.repo,
        confirmLabel: 'Pull',
        destructive: false,
      }))
    )
      return false
  }
  const id = nextRequest(key)
  patch(key, { busy: action, error: undefined })
  try {
    const status = await gitSync(componentPaths(), scope.repo, action, scope.worktree)
    if (requests.get(key) === id) patch(key, { status, busy: undefined })
    else patch(key, { busy: undefined })
    if (!quiet) {
      const where = status.upstream ?? status.remote ?? 'the remote'
      useStore.getState().setMessage(`${DONE[action]} ${status.branch ?? 'HEAD'} · ${where}`, true)
    }
    return true
  } catch (e) {
    patch(key, { busy: undefined, error: String(e) })
    if (!quiet) useStore.getState().setMessage(String(e), undefined, undefined, 'error')
    return false
  } finally {
    if (action !== 'fetch') {
      await Promise.all([refreshTasks(scope.projectId), requestGitRefresh(scope.projectId)])
    }
  }
}

/** The commit chosen in the Git panel's history, shown in Review's or Chat's diff pane. */
interface CommitChoice {
  projectId: string
  worktree?: string
  selection: HistorySelection
}

export const useCommitChoice = create<{ choice: CommitChoice | null }>(() => ({ choice: null }))

export function chooseCommit(
  projectId: string,
  worktree: string | undefined,
  selection: HistorySelection | null,
) {
  useCommitChoice.setState({ choice: selection ? { projectId, worktree, selection } : null })
}

/** The commit chosen for the active project and worktree, or `null`. */
export function useChosenCommit(): HistorySelection | null {
  const projectId = useStore((s) => s.project?.id)
  const worktree = useStore(activeWorktree)
  const choice = useCommitChoice((s) => s.choice)
  return choice && choice.projectId === projectId && choice.worktree === worktree
    ? choice.selection
    : null
}

/** Clear or change the chosen commit for the active project and worktree. */
export function setChosenCommit(selection: HistorySelection | null) {
  const s = useStore.getState()
  if (!s.project) return
  chooseCommit(s.project.id, activeWorktree(s), selection)
}

/** Open the chosen commit where its diff shows: Chat's Changes in Chat mode, otherwise Review. */
export function showCommit(selection: HistorySelection | null) {
  setChosenCommit(selection)
  if (!selection) return
  const s = useStore.getState()
  if (s.simpleMode)
    useSimpleUi.getState().patch(simpleKey(s.project?.id, s.activeTask), { changes: true })
  else if (s.view !== 'review') s.setView('review')
}

/** The repositories of the active worktree and the one the Git panel shows. */
export const useSyncScope = create<{
  scope: SyncScope | null
  repos: string[] | null
  /** The repository chosen per project and worktree, when not the first. */
  chosen: Record<string, string>
}>(() => ({ scope: null, repos: null, chosen: {} }))

const contextKey = (projectId: string, worktree?: string) =>
  JSON.stringify([projectId, worktree ?? null])

/** Show `repo` in the Git panel for the active project and worktree. */
export function chooseRepo(repo: string) {
  const s = useStore.getState()
  if (!s.project) return
  const key = contextKey(s.project.id, activeWorktree(s))
  useSyncScope.setState((state) => ({ chosen: { ...state.chosen, [key]: repo } }))
}

/**
 * Keep the active worktree's sync status current from local refs: when the scope changes, on Git
 * refreshes, and when branches change. It never talks to the remote. Mounted once, by the rail.
 */
export function useSyncTracking() {
  const projectId = useStore((s) => s.project?.id)
  const worktree = useStore(activeWorktree)
  const paths = useStore((s) => s.nodes.map((n) => n.data.path).join('\0'))
  const revision = useStore((s) => s.gitChanges)
  const branch = useMainWorktree((s) => (projectId ? s[projectId]?.branch : undefined))
  const taskBranch = useStore((s) => s.tasks.find((t) => t.id === s.activeTask)?.branch)
  const repos = useSyncScope((s) => s.repos)
  const chosen = useSyncScope((s) =>
    projectId ? s.chosen[contextKey(projectId, worktree)] : undefined,
  )
  useEffect(() => {
    useSyncScope.setState({ repos: null, scope: null })
    if (!projectId) return
    let alive = true
    void historyRequest<string[]>(worktree)
      .then((result) => {
        if (alive) useSyncScope.setState({ repos: result })
      })
      .catch(() => {
        if (alive) useSyncScope.setState({ repos: [] })
      })
    return () => {
      alive = false
    }
  }, [projectId, worktree, paths])
  const repo = repos && (chosen && repos.includes(chosen) ? chosen : repos[0])
  useEffect(() => {
    useSyncScope.setState({ scope: projectId && repo ? { projectId, worktree, repo } : null })
  }, [projectId, worktree, repo])
  useEffect(() => {
    if (projectId && repo) void refreshSyncStatus({ projectId, worktree, repo })
  }, [projectId, worktree, repo, revision, branch, taskBranch])
}

/** The Git panel's scope and its status entry. */
export function useSyncEntry(): { scope: SyncScope | null; entry: SyncEntry } {
  const scope = useSyncScope((s) => s.scope)
  const entry = useGitSync((s) => (scope ? s[syncKey(scope)] : undefined))
  return { scope, entry: entry ?? {} }
}
