import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import { terminalStop, worktreeReservations } from './ipc'
import { warnAfterResume, warnReservedFolder } from './reservedWorktree'

vi.mock('./ipc', () => ({
  worktreeReservations: vi.fn(async () => []),
  terminalStop: vi.fn(async () => {}),
}))

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({ message: '', messageAction: null, sessionRecords: [] })
})

test('a resumed session in a reserved folder warns and offers to stop the merge agent', async () => {
  // A project's action runs only while that project is active.
  useStore.setState({
    project: { id: 'p', name: 'P' } as never,
    sessionRecords: [
      { id: 's', metadata: { projectId: 'p' }, spec: { cwd: '/repo/web', command: '' } } as never,
    ],
  })
  vi.mocked(worktreeReservations).mockResolvedValueOnce([{ id: 'merge', name: 'Merge x → main' }])
  await warnAfterResume('s')
  expect(worktreeReservations).toHaveBeenCalledWith('/repo/web')
  expect(useStore.getState().message).toContain('“Merge x → main” is still running')
  useStore.getState().messageAction?.run()
  expect(terminalStop).toHaveBeenCalledWith('merge')
})

test('the session itself, or a failed lookup, says nothing', async () => {
  vi.mocked(worktreeReservations).mockResolvedValueOnce([{ id: 's', name: 'Merge x → main' }])
  await warnReservedFolder('p', 's', '/repo')
  vi.mocked(worktreeReservations).mockRejectedValueOnce(new Error('Disconnected'))
  await warnReservedFolder('p', 't', '/repo')
  expect(useStore.getState().message).toBe('')
})
