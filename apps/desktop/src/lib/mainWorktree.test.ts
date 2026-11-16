import { beforeEach, expect, test, vi } from 'vitest'
import type { Worktree } from '../types'
import { gitWorktrees } from './ipc'
import {
  ensureMainWorktree,
  forgetMainWorktree,
  readMainWorktrees,
  refreshMainWorktree,
  scheduleBranchRefresh,
  useMainWorktree,
} from './mainWorktree'

vi.mock('./ipc', () => ({ gitWorktrees: vi.fn() }))

function deferred() {
  let resolve!: (list: Worktree[]) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Worktree[]>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const tree = (branch: string) => [{ current: true, branch }] as Worktree[]
const settle = () => new Promise<void>((resolve) => setTimeout(resolve))

beforeEach(() => {
  for (const id of ['p', 'q']) forgetMainWorktree(id)
  vi.resetAllMocks()
})

test.each(['resolve', 'reject'] as const)(
  'a forgotten read cannot %s into a reopened project with the same id',
  async (outcome) => {
    const stale = deferred()
    const fresh = deferred()
    vi.mocked(gitWorktrees).mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    refreshMainWorktree('p')
    forgetMainWorktree('p')
    ensureMainWorktree('p')
    fresh.resolve(tree('new-root'))
    await settle()
    if (outcome === 'resolve') stale.resolve(tree('old-root'))
    else stale.reject(new Error('old root missing'))
    await settle()
    expect(useMainWorktree.getState().p).toEqual({ git: true, branch: 'new-root' })
  },
)

test('only the latest read applies, independently for each project', async () => {
  const older = deferred()
  vi.mocked(gitWorktrees)
    .mockReturnValueOnce(older.promise)
    .mockResolvedValueOnce(tree('other'))
    .mockResolvedValueOnce(tree('latest'))
  refreshMainWorktree('p')
  refreshMainWorktree('q')
  refreshMainWorktree('p')
  await settle()
  older.resolve(tree('stale'))
  await settle()
  expect(useMainWorktree.getState()).toEqual({
    p: { git: true, branch: 'latest' },
    q: { git: true, branch: 'other' },
  })
})

test('a read that finishes after closing cannot restore the forgotten entry', async () => {
  const stale = deferred()
  vi.mocked(gitWorktrees).mockReturnValueOnce(stale.promise)
  refreshMainWorktree('p')
  forgetMainWorktree('p')
  stale.resolve(tree('closed'))
  await settle()
  expect(useMainWorktree.getState().p).toBeUndefined()
})

test('a menu listing numbered before a newer read cannot override it, even answering last', async () => {
  const menu = deferred()
  vi.mocked(gitWorktrees).mockResolvedValueOnce(tree('feat'))
  void readMainWorktrees('p', menu.promise)
  refreshMainWorktree('p')
  await settle()
  expect(useMainWorktree.getState().p).toEqual({ git: true, branch: 'feat' })
  menu.resolve(tree('main'))
  await settle()
  expect(useMainWorktree.getState().p).toEqual({ git: true, branch: 'feat' })
})

test('a menu listing started last supersedes an older read', async () => {
  const older = deferred()
  vi.mocked(gitWorktrees).mockReturnValueOnce(older.promise)
  refreshMainWorktree('p')
  await readMainWorktrees('p', Promise.resolve(tree('agent-branch')))
  await settle()
  older.resolve(tree('stale'))
  await settle()
  expect(useMainWorktree.getState().p).toEqual({ git: true, branch: 'agent-branch' })
})

test('an unchanged listing keeps the same entry, so subscribers do not re-render', async () => {
  await readMainWorktrees('p', Promise.resolve(tree('main')))
  await settle()
  const before = useMainWorktree.getState().p
  await readMainWorktrees('p', Promise.resolve(tree('main')))
  await settle()
  expect(useMainWorktree.getState().p).toBe(before)
})

test('a detached main worktree is labelled with its short commit', async () => {
  await readMainWorktrees(
    'p',
    Promise.resolve([{ current: true, head: '0123456789abcdef' }] as Worktree[]),
  )
  await settle()
  expect(useMainWorktree.getState().p).toEqual({ git: true, branch: 'detached 0123456' })
})

test('closing a project cancels its scheduled branch refresh', async () => {
  vi.useFakeTimers()
  try {
    const also = vi.fn()
    scheduleBranchRefresh('p', also)
    forgetMainWorktree('p')
    await vi.runAllTimersAsync()
    expect(gitWorktrees).not.toHaveBeenCalled()
    expect(also).not.toHaveBeenCalled()
    expect(useMainWorktree.getState().p).toBeUndefined()
  } finally {
    vi.useRealTimers()
  }
})

test('a burst of branch signals settles to one read', async () => {
  vi.useFakeTimers()
  try {
    vi.mocked(gitWorktrees).mockResolvedValue(tree('feat'))
    const also = vi.fn()
    for (let i = 0; i < 3; i++) scheduleBranchRefresh('p', also)
    await vi.runAllTimersAsync()
    expect(gitWorktrees).toHaveBeenCalledTimes(1)
    expect(also).toHaveBeenCalledOnce()
    expect(useMainWorktree.getState().p).toEqual({ git: true, branch: 'feat' })
  } finally {
    vi.useRealTimers()
  }
})
