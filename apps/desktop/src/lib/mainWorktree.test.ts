import { beforeEach, expect, test, vi } from 'vitest'
import type { Worktree } from '../types'
import { gitWorktrees } from './ipc'
import {
  ensureMainWorktree,
  forgetMainWorktree,
  refreshMainWorktree,
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
