import { afterEach, expect, test, vi } from 'vitest'
import type { TerminalSnapshot } from '../types'
import { terminalSnapshot, terminalStop } from './ipc'
import { stopAndWait } from './stopAndWait'
vi.mock('./ipc', () => ({ terminalSnapshot: vi.fn(), terminalStop: vi.fn() }))
afterEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
})

test('waits for every stopped process and requests no terminal output', async () => {
  vi.useFakeTimers()
  vi.mocked(terminalSnapshot)
    .mockResolvedValueOnce({ running: false } as TerminalSnapshot)
    .mockResolvedValueOnce({ running: true } as TerminalSnapshot)
    .mockResolvedValue({ running: false } as TerminalSnapshot)
  const stopped = stopAndWait(['a', 'b'], 'still stopping')
  await vi.advanceTimersByTimeAsync(100)
  expect(await stopped).toBe(true)
  expect(vi.mocked(terminalStop).mock.calls).toEqual([['a'], ['b']])
  expect(vi.mocked(terminalSnapshot).mock.calls).toEqual([
    ['a', 0],
    ['b', 0],
    ['a', 0],
    ['b', 0],
  ])
})

test('cancels a stale handoff while waiting for exit', async () => {
  let valid = true
  vi.mocked(terminalSnapshot).mockImplementation(async () => {
    valid = false
    return { running: true } as TerminalSnapshot
  })
  expect(await stopAndWait('a', 'still stopping', () => valid)).toBe(false)
})

test('times out with the caller action and propagates stop failures', async () => {
  vi.useFakeTimers()
  vi.mocked(terminalSnapshot).mockResolvedValue({ running: true } as TerminalSnapshot)
  const stopped = expect(stopAndWait('a', 'Try Review again.')).rejects.toThrow('Try Review again.')
  await vi.advanceTimersByTimeAsync(10000)
  await stopped
  vi.mocked(terminalStop).mockRejectedValueOnce(new Error('stop failed'))
  await expect(stopAndWait('a', 'timeout')).rejects.toThrow('stop failed')
})
