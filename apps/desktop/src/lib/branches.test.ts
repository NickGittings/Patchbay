import { beforeEach, expect, test, vi } from 'vitest'
import type { Worktree } from '../types'
import { changeBranch } from './branches'
import { gitBranchAction } from './ipc'
import { confirmAction } from './confirm'

vi.mock('./ipc', () => ({ gitBranchAction: vi.fn() }))
vi.mock('./confirm', () => ({ confirmAction: vi.fn() }))

const current: Worktree = {
  path: '/repo',
  head: 'original-head',
  branch: 'feature',
  current: true,
  main: true,
}
const action = { kind: 'switch', branch: 'main' } as const

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(confirmAction).mockResolvedValue(true)
})

test('an idle worktree switches without a prompt', async () => {
  vi.mocked(gitBranchAction).mockResolvedValue('applied')
  expect(await changeBranch('p', current, action)).toBe(true)
  expect(confirmAction).not.toHaveBeenCalled()
  expect(gitBranchAction).toHaveBeenCalledExactlyOnceWith(
    'p',
    'original-head',
    'feature',
    action,
    '/repo',
    false,
  )
})

test('cancelling leaves running work and the branch alone', async () => {
  vi.mocked(gitBranchAction).mockResolvedValue('needsStop')
  vi.mocked(confirmAction).mockResolvedValue(false)
  expect(await changeBranch('p', current, action)).toBe(false)
  expect(gitBranchAction).toHaveBeenCalledOnce()
  expect(confirmAction).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('switch to “main”') }),
  )
  expect(confirmAction).toHaveBeenCalledWith(expect.objectContaining({ detail: '/repo' }))
})

test('confirmation retries with permission to stop and the original checkout identity', async () => {
  vi.mocked(gitBranchAction).mockResolvedValueOnce('needsStop').mockResolvedValueOnce('applied')
  expect(await changeBranch('p', current, action)).toBe(true)
  expect(gitBranchAction).toHaveBeenLastCalledWith(
    'p',
    'original-head',
    'feature',
    action,
    '/repo',
    true,
  )
  expect(confirmAction).toHaveBeenCalledOnce()
})

test('Git or stop failures propagate without another attempt', async () => {
  vi.mocked(gitBranchAction).mockRejectedValueOnce(new Error('Commit your changes'))
  await expect(changeBranch('p', current, action)).rejects.toThrow('Commit your changes')
  expect(confirmAction).not.toHaveBeenCalled()
  vi.mocked(gitBranchAction)
    .mockResolvedValueOnce('needsStop')
    .mockRejectedValueOnce(new Error('Stop failed'))
  await expect(changeBranch('p', current, action)).rejects.toThrow('Stop failed')
  expect(gitBranchAction).toHaveBeenCalledTimes(3)
})
