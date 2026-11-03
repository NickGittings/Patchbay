import { afterEach, expect, it, vi } from 'vitest'

const { read, state } = vi.hoisted(() => ({ read: vi.fn(), state: vi.fn() }))
vi.mock('./ipc', () => ({ worktreeSetup: read }))
vi.mock('../store', () => ({ projectStateOf: state }))
import { waitForSetup } from './worktreeSetup'

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

it('keeps a launch waiting through failure and retry, then releases it once', async () => {
  vi.useFakeTimers()
  state.mockReturnValue({ tasks: [{ id: 't', setup: { command: 'install' } }] })
  read
    .mockResolvedValueOnce({ status: 'preparing' })
    .mockResolvedValueOnce({ status: 'failed' })
    .mockResolvedValueOnce({ status: 'stopped' })
    .mockResolvedValueOnce({ status: 'preparing' })
    .mockResolvedValue({ status: 'ready' })
  const launch = vi.fn()
  const waiting = waitForSetup('p', 't').then(launch)
  await vi.advanceTimersByTimeAsync(1500)
  expect(launch).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  await waiting
  expect(launch).toHaveBeenCalledTimes(1)
  expect(read.mock.calls.every((args) => args.length === 2)).toBe(true)
})

it('releases an explicit bypass and leaves existing checkouts alone', async () => {
  state.mockReturnValue({ tasks: [{ id: 't', setup: {} }] })
  read.mockResolvedValue({ status: 'skipped' })
  await waitForSetup('p', 't')
  expect(read).toHaveBeenCalledTimes(1)
  read.mockClear()
  state.mockReturnValue({ tasks: [{ id: 'attached' }] })
  await waitForSetup('p', 'attached')
  await waitForSetup('p', null)
  expect(read).not.toHaveBeenCalled()
})

it('stops polling when cancelled during an in-flight setup read', async () => {
  vi.useFakeTimers()
  state.mockReturnValue({ tasks: [{ id: 't', setup: {} }] })
  let cancelled = false
  read.mockImplementation(async () => {
    cancelled = true
    return { status: 'failed' }
  })
  await waitForSetup('p', 't', () => cancelled)
  expect(vi.getTimerCount()).toBe(0)
  expect(read).toHaveBeenCalledTimes(1)
})
