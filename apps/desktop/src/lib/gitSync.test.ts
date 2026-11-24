import { beforeEach, expect, test, vi } from 'vitest'
import { create } from 'zustand'
import type { SyncStatus, View } from '../types'

vi.mock('../store', () => ({
  useStore: create(() => ({
    project: { id: 'one' },
    activeTask: null as string | null,
    tasks: [
      { id: 'task', current: false, worktree: '/wt' },
      { id: 'here', current: true, worktree: '/repo' },
    ],
    nodes: [],
    simpleMode: false,
    view: 'plan' as View,
    sessionRecords: [] as unknown[],
    sessions: {} as Record<string, { running: boolean }>,
    setView: (view: View) => store.setState({ view }),
    setMessage: vi.fn(),
  })),
}))
vi.mock('./ipc', () => ({ gitSync: vi.fn(), gitSyncStatus: vi.fn(), gitHistory: vi.fn() }))
vi.mock('./confirm', () => ({ confirmAction: vi.fn() }))
vi.mock('./git', () => ({ componentPaths: () => [], requestGitRefresh: vi.fn() }))
vi.mock('./tasks', () => ({ activeWorktree: () => undefined, refreshTasks: vi.fn() }))

const { useStore: store } = await import('../store')
const { gitSync, gitSyncStatus } = await import('./ipc')
const { confirmAction } = await import('./confirm')
const { requestGitRefresh } = await import('./git')
const { refreshSyncStatus, runSync, showCommit, syncKey, useCommitChoice, useGitSync } =
  await import('./gitSync')
const { useSimpleUi, simpleKey } = await import('./simpleUi')

const scope = { projectId: 'one', repo: '/repo' }
const status = (ahead: number, behind: number): SyncStatus => ({
  branch: 'main',
  upstream: 'origin/main',
  missingUpstream: null,
  remote: 'origin',
  ahead,
  behind,
  lastFetchMs: null,
  pushTo: 'origin/main',
  pushRefused: null,
  unpushed: ahead,
  pushBehind: behind,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const record = (task: string | null) => ({
  id: `s-${task}`,
  metadata: { projectId: 'one', task },
  snapshot: { running: true },
})

beforeEach(() => {
  vi.clearAllMocks()
  useGitSync.setState({}, true)
  useCommitChoice.setState({ choice: null })
  store.setState({ sessionRecords: [], sessions: {}, simpleMode: false, view: 'plan' } as never)
  vi.mocked(confirmAction).mockResolvedValue(true)
})

test('an older status reply never replaces a newer one', async () => {
  const first = deferred<SyncStatus>()
  vi.mocked(gitSyncStatus).mockReturnValueOnce(first.promise).mockResolvedValueOnce(status(2, 0))
  const older = refreshSyncStatus(scope)
  await refreshSyncStatus(scope)
  first.resolve(status(1, 0))
  await older
  expect(useGitSync.getState()[syncKey(scope)].status?.ahead).toBe(2)
})

test('pull asks before changing files under terminals running in the worktree', async () => {
  store.setState({ sessionRecords: [record(null), record('task')] } as never)
  vi.mocked(confirmAction).mockResolvedValue(false)
  expect(await runSync(scope, 'pull')).toBe(false)
  expect(confirmAction).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('1 terminal is running') }),
  )
  expect(gitSync).not.toHaveBeenCalled()
})

test('push needs no confirmation and refreshes Git state afterwards', async () => {
  store.setState({ sessionRecords: [record(null)] } as never)
  vi.mocked(gitSync).mockResolvedValue(status(0, 0))
  expect(await runSync(scope, 'push')).toBe(true)
  expect(confirmAction).not.toHaveBeenCalled()
  expect(gitSync).toHaveBeenCalledWith([], '/repo', 'push', undefined, 'one')
  expect(requestGitRefresh).toHaveBeenCalledWith('one')
  expect(useGitSync.getState()[syncKey(scope)]).toMatchObject({ status: status(0, 0) })
  expect(useGitSync.getState()[syncKey(scope)].busy).toBeUndefined()
})

test('a failed action keeps the last status and records its error', async () => {
  useGitSync.setState({ [syncKey(scope)]: { status: status(1, 1) } })
  vi.mocked(gitSync).mockRejectedValue('diverged')
  expect(await runSync(scope, 'pull', { quiet: true })).toBe(false)
  expect(useGitSync.getState()[syncKey(scope)]).toMatchObject({
    status: status(1, 1),
    error: 'diverged',
  })
  // The Git refresh after a failure re-reads status; that must not hide the action's error.
  vi.mocked(gitSyncStatus).mockResolvedValue(status(1, 1))
  await refreshSyncStatus(scope)
  expect(useGitSync.getState()[syncKey(scope)].error).toBe('diverged')
})

test('terminals of a task checked out in the project folder count for its pull', async () => {
  store.setState({ sessionRecords: [record('here')] } as never)
  vi.mocked(confirmAction).mockResolvedValue(false)
  expect(await runSync(scope, 'pull')).toBe(false)
  expect(confirmAction).toHaveBeenCalled()
})

test('an action started while the pull dialog was open keeps the pull from running', async () => {
  store.setState({ sessionRecords: [record(null)] } as never)
  const answer = deferred<boolean>()
  vi.mocked(confirmAction).mockReturnValue(answer.promise)
  const fetched = deferred<SyncStatus>()
  vi.mocked(gitSync).mockReturnValueOnce(fetched.promise)
  const pull = runSync(scope, 'pull')
  const fetch = runSync(scope, 'fetch', { quiet: true })
  answer.resolve(true)
  expect(await pull).toBe(false)
  expect(gitSync).toHaveBeenCalledTimes(1)
  expect(useGitSync.getState()[syncKey(scope)].busy).toBe('fetch')
  fetched.resolve(status(0, 0))
  await fetch
  expect(useGitSync.getState()[syncKey(scope)].busy).toBeUndefined()
})

test('a chosen commit opens in Review, or in Chat when Chat mode is on', () => {
  const selection = { repo: '/repo', commit: { hash: 'a' } } as never
  showCommit(selection)
  expect(store.getState().view).toBe('review')
  expect(useCommitChoice.getState().choice).toEqual({
    projectId: 'one',
    worktree: undefined,
    selection,
  })
  store.setState({ simpleMode: true, view: 'navigation' } as never)
  showCommit(selection)
  expect(store.getState().view).toBe('navigation')
  expect(useSimpleUi.getState().worktrees[simpleKey('one', null)]?.changes).toBe(true)
})
