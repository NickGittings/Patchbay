import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import type { ActionReport, Task } from '../types'
vi.mock('./ipc', () => ({
  graphActionRun: vi.fn(),
  graphGroupStop: vi.fn(),
  graphValidationCancel: vi.fn(),
}))
vi.mock('./sessions', () => ({
  listenForTerminals: vi.fn(async () => {}),
  refreshSession: vi.fn(async () => {}),
  reconcileSessions: vi.fn(),
}))
const { graphActionRun } = await import('./ipc')
const { runGraphAction } = await import('./actions')
const task = (id: string): Task => ({
  id,
  title: id,
  worktree: `/p-${id}`,
  branch: id,
  components: ['web'],
  notes: '',
  createdMs: 1,
  missing: false,
  current: false,
})
beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    root: '/p',
    name: 'P',
    schemaVersion: 4,
    links: [],
    components: [],
  })
  useStore.getState().setTasks([task('one'), task('two')])
  useStore.getState().setActiveTask('one')
})
test('an asynchronous action completes in its launch task after a tab switch', async () => {
  let resolve!: (report: ActionReport) => void
  vi.mocked(graphActionRun).mockReturnValueOnce(new Promise((done) => (resolve = done)))
  const request = { kind: 'validateAffected' as const, componentId: 'web' }
  const running = runGraphAction(request)
  await vi.waitFor(() => expect(graphActionRun).toHaveBeenCalled())
  expect(graphActionRun).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 'p' }),
    request,
    'one',
  )
  useStore.getState().setActiveTask('two')
  const message = useStore.getState().message
  const report: ActionReport = {
    plan: { task: 'one', request, stages: [], sessions: [], skipped: ['web'] },
    results: [],
  }
  resolve(report)
  await running
  expect(useStore.getState().graphActionReport).toBeNull()
  expect(useStore.getState().graphActionBusy).toBe(false)
  expect(useStore.getState().message).toBe(message)
  useStore.getState().setActiveTask('one')
  expect(useStore.getState().graphActionReport).toEqual(report)
  expect(useStore.getState().graphActionBusy).toBe(false)
})
test('an asynchronous failure cannot overwrite the newly selected task message', async () => {
  let reject!: (error: Error) => void
  vi.mocked(graphActionRun).mockReturnValueOnce(new Promise((_, fail) => (reject = fail)))
  const running = runGraphAction({ kind: 'startGroup', groupId: 'dev' })
  await vi.waitFor(() => expect(graphActionRun).toHaveBeenCalled())
  useStore.getState().setActiveTask('two')
  useStore.getState().setMessage('Current task')
  reject(new Error('Old task failed'))
  await running
  expect(useStore.getState().message).toBe('Current task')
  useStore.getState().setActiveTask('one')
  expect(useStore.getState().graphActionBusy).toBe(false)
})
