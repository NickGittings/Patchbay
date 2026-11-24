import { listen } from '@tauri-apps/api/event'
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { useStore } from '../store'
import type { SyncAction, SyncStatus } from '../types'
import { confirmAction } from './confirm'
import { componentPaths, requestGitRefresh } from './git'
import { historyRequest, type HistorySelection } from './history'
import { BRANCHES_CHANGED_EVENT, gitSync, gitSyncStatus } from './ipc'
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
  /** The last action's failure, kept until the next action so status refreshes don't hide it. */
  error?: string
  /** The last status read's failure, cleared by the next successful read. */
  statusError?: string
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

/** Per scope, the action that owns `busy`, so an older action never clears a newer one's flag. */
const actions = new Map<string, number>()

/** Git commands read the open project's map, so another project's scope waits until it's open. */
const isOpen = (scope: SyncScope) => useStore.getState().project?.id === scope.projectId

/** Read the scope's status from local refs. Failures keep the last status and record the error. */
export async function refreshSyncStatus(scope: SyncScope) {
  if (!isOpen(scope)) return
  const key = syncKey(scope)
  const id = nextRequest(key)
  try {
    const status = await gitSyncStatus(
      componentPaths(),
      scope.repo,
      scope.worktree,
      scope.projectId,
    )
    if (requests.get(key) === id) patch(key, { status, statusError: undefined })
  } catch (e) {
    if (requests.get(key) === id) patch(key, { statusError: String(e) })
  }
}

/**
 * Sessions of `projectId` running in the checkout `worktree` names (`undefined` for the open
 * one). A task whose branch is checked out in the project folder runs there too, and a session
 * of a task no longer listed counts, since its folder is unknown.
 */
export function runningInWorktree(projectId: string, worktree: string | undefined) {
  const { sessionRecords, sessions, tasks } = useStore.getState()
  return sessionRecords.filter((r) => {
    if (r.metadata.projectId !== projectId || !(sessions[r.id]?.running ?? sessionLive(r)))
      return false
    const id = r.metadata.task ?? null
    if (id === null) return worktree === undefined
    const task = tasks.find((t) => t.id === id)
    return !task || (task.current ? undefined : task.worktree) === worktree
  }).length
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
  { quiet = false }: { quiet?: boolean } = {},
) {
  const key = syncKey(scope)
  const busy = () => !!useGitSync.getState()[key]?.busy
  if (busy() || !isOpen(scope)) return false
  if (action === 'pull') {
    const running = runningInWorktree(scope.projectId, scope.worktree)
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
    // Another action may have started, or the project closed, while the dialog was open.
    if (busy() || !isOpen(scope)) return false
  }
  const id = nextRequest(key)
  const token = (actions.get(key) ?? 0) + 1
  actions.set(key, token)
  patch(key, { busy: action, error: undefined })
  const settle = (entry: Partial<SyncEntry>) =>
    patch(key, actions.get(key) === token ? { ...entry, busy: undefined } : entry)
  try {
    const status = await gitSync(
      componentPaths(),
      scope.repo,
      action,
      scope.worktree,
      scope.projectId,
    )
    settle(requests.get(key) === id ? { status, statusError: undefined } : {})
    if (!quiet) {
      const where =
        (action === 'push' ? status.pushTo : status.upstream) ?? status.remote ?? 'the remote'
      useStore.getState().setMessage(`${DONE[action]} ${status.branch ?? 'HEAD'} · ${where}`, true)
    }
    return true
  } catch (e) {
    settle({ error: String(e) })
    if (!quiet) useStore.getState().setMessage(String(e), undefined, undefined, 'error')
    return false
  } finally {
    if (action !== 'fetch') {
      await Promise.all([refreshTasks(scope.projectId), requestGitRefresh(scope.projectId)])
    }
  }
}

/** The commit chosen in the Git panel's history, shown in Review's or Chat's diff pane. */
export interface CommitChoice {
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

/**
 * The commit chosen for the active project and worktree, or `null`. Its `worktree` is the one
 * the history listed it from, so its details read the same repository.
 */
export function useChosenCommit(): CommitChoice | null {
  const projectId = useStore((s) => s.project?.id)
  const worktree = useStore(activeWorktree)
  const choice = useCommitChoice((s) => s.choice)
  return choice && choice.projectId === projectId && choice.worktree === worktree ? choice : null
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
  /** The project and worktree `repos` lists, so a switch never pairs one with another's repo. */
  reposFor: string | null
  /** Why listing the repositories failed. */
  reposError: string | null
  /** Bumped to list the repositories again. */
  retry: number
  /** The repository chosen per project and worktree, when not the first. */
  chosen: Record<string, string>
}>(() => ({
  scope: null,
  repos: null,
  reposFor: null,
  reposError: null,
  retry: 0,
  chosen: {},
}))

/** List the active worktree's repositories again, after a failure. */
export const retryRepos = () => useSyncScope.setState((s) => ({ retry: s.retry + 1 }))

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
  const retry = useSyncScope((s) => s.retry)
  // Refs move on commits, fetches and branch switches, which the watcher reports as branch
  // changes; terminals can also fetch while the window is in the background.
  const [refs, setRefs] = useState(0)
  useEffect(() => {
    if (!projectId) return
    const bump = () => setRefs((n) => n + 1)
    const unlisten = listen<string>(BRANCHES_CHANGED_EVENT, (e) => {
      if (e.payload === projectId) bump()
    })
    window.addEventListener('focus', bump)
    return () => {
      void unlisten.then((stop) => stop())
      window.removeEventListener('focus', bump)
    }
  }, [projectId])
  const context = projectId ? contextKey(projectId, worktree) : null
  const repos = useSyncScope((s) => (s.reposFor === context ? s.repos : null))
  const chosen = useSyncScope((s) => (context ? s.chosen[context] : undefined))
  useEffect(() => {
    useSyncScope.setState({ repos: null, reposFor: null, reposError: null, scope: null })
    if (!projectId || !context) return
    let alive = true
    const listed = (result: string[], error: string | null = null) => {
      if (!alive) return
      useSyncScope.setState({ repos: result, reposFor: context, reposError: error })
      // A commit from a repository no longer on the map can't be read any more.
      const choice = useCommitChoice.getState().choice
      if (
        choice?.projectId === projectId &&
        choice.worktree === worktree &&
        !result.includes(choice.selection.repo)
      )
        useCommitChoice.setState({ choice: null })
    }
    void historyRequest<string[]>(worktree)
      .then(listed)
      .catch((e) => listed([], String(e)))
    return () => {
      alive = false
    }
  }, [projectId, worktree, context, paths, retry])
  const repo = repos && (chosen && repos.includes(chosen) ? chosen : repos[0])
  useEffect(() => {
    useSyncScope.setState({ scope: projectId && repo ? { projectId, worktree, repo } : null })
  }, [projectId, worktree, repo])
  useEffect(() => {
    if (projectId && repo) void refreshSyncStatus({ projectId, worktree, repo })
  }, [projectId, worktree, repo, refs])
}

/** The Git panel's scope and its status entry. */
export function useSyncEntry(): { scope: SyncScope | null; entry: SyncEntry } {
  const scope = useSyncScope((s) => s.scope)
  const entry = useGitSync((s) => (scope ? s[syncKey(scope)] : undefined))
  return { scope, entry: entry ?? {} }
}
