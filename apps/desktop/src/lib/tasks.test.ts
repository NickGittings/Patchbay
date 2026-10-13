import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import { sessionMetadata, type Task } from '../types'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'main' }),
}))
vi.mock('./ipc', () => ({
  taskUpdate: vi.fn(),
  taskList: vi.fn(),
  taskActivate: vi.fn(async () => {}),
  taskCreate: vi.fn(),
  taskCheckRemovable: vi.fn(async () => {}),
  graphTaskStop: vi.fn(async () => {}),
  terminalStop: vi.fn(async () => {}),
  terminalSnapshot: vi.fn(async () => ({ running: false })),
  taskRemove: vi.fn(async () => {}),
  sessionForget: vi.fn(async () => {}),
}))
vi.mock('./git', () => ({ invalidateGitRefresh: vi.fn(), requestGitRefresh: vi.fn() }))
vi.mock('./sessions', () => ({ reconcileSessions: vi.fn(async () => {}) }))
const { cancelNewTask, createTask, followActiveTask, seedNewTask, removeTask } =
  await import('./tasks')
const {
  taskCreate,
  taskUpdate,
  taskList,
  taskRemove,
  sessionForget,
  taskCheckRemovable,
  terminalStop,
  graphTaskStop,
} = await import('./ipc')
const { reconcileSessions } = await import('./sessions')

let stop: (() => void) | undefined
beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
  cancelNewTask()
  for (const sid of [
    'running-task',
    'exited-task',
    'retained-task',
    'other-project',
    'main-worktree',
  ])
    sessionMetadata.delete(sid)
})

function removalSessions() {
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    name: 'P',
    root: '/p',
    schemaVersion: 4,
    links: [],
    components: [],
  })
  for (const [sid, projectId, task] of [
    ['running-task', 'p', 't'],
    ['exited-task', 'p', 't'],
    ['retained-task', 'p', 't'],
    ['other-project', 'other', 't'],
    ['main-worktree', 'p', null],
  ] as const)
    sessionMetadata.set(sid, { projectId, task, componentId: 'web', terminalId: sid })
  useStore.setState({
    sessions: {
      'running-task': { running: true },
      'exited-task': { running: false },
      'other-project': { running: true },
      'main-worktree': { running: true },
    },
  })
  vi.mocked(taskList).mockResolvedValue([])
}

test.each([true, false])(
  'removal (%s) forgets all task records only in its project',
  async (remove) => {
    removalSessions()
    await removeTask('t', remove)
    expect(taskRemove).toHaveBeenCalledWith('t', remove, 'p')
    expect(vi.mocked(sessionForget).mock.calls.map(([sid]) => sid)).toEqual([
      'running-task',
      'exited-task',
      'retained-task',
    ])
    expect(vi.mocked(taskRemove).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sessionForget).mock.invocationCallOrder[0],
    )
    expect(vi.mocked(sessionForget).mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(reconcileSessions).mock.invocationCallOrder[0],
    )
    expect(reconcileSessions).toHaveBeenCalledOnce()
  },
)

test('a refused task removal keeps session records and still refreshes tasks', async () => {
  removalSessions()
  vi.mocked(taskRemove).mockRejectedValueOnce(new Error('removal refused'))
  await expect(removeTask('t', true)).rejects.toThrow('removal refused')
  expect(sessionForget).not.toHaveBeenCalled()
  expect(reconcileSessions).not.toHaveBeenCalled()
  expect(taskList).toHaveBeenCalledWith('p')
})

test('a worktree preflight refusal keeps running sessions', async () => {
  removalSessions()
  vi.mocked(taskCheckRemovable).mockRejectedValueOnce(new Error('dirty worktree'))
  await expect(removeTask('t', true)).rejects.toThrow('dirty worktree')
  expect(taskRemove).not.toHaveBeenCalled()
  expect(sessionForget).not.toHaveBeenCalled()
  expect(terminalStop).not.toHaveBeenCalled()
  expect(graphTaskStop).not.toHaveBeenCalled()
})

test('a forget refusal does not prevent forgetting other sessions or reconciliation', async () => {
  removalSessions()
  vi.mocked(sessionForget).mockRejectedValueOnce(new Error('still running'))
  await removeTask('t', false)
  expect(sessionForget).toHaveBeenCalledTimes(3)
  expect(reconcileSessions).toHaveBeenCalledOnce()
})

test('cancelling the worktree dialog clears its pending follow-up', async () => {
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    name: 'P',
    root: '/p',
    schemaVersion: 4,
    links: [],
    components: [],
  })
  const task: Task = {
    id: 't',
    title: 'T',
    worktree: '/t',
    branch: 't',
    components: [],
    notes: '',
    createdMs: 1,
    missing: false,
    current: false,
  }
  vi.mocked(taskCreate).mockResolvedValue(task)
  vi.mocked(taskList).mockResolvedValue([task])
  const then = vi.fn()
  seedNewTask(then)
  cancelNewTask()
  expect(useStore.getState().newTask).toBeNull()
  await createTask({ title: 'T', branch: 't', components: [] })
  expect(useStore.getState().activeTask).toBe('t')
  expect(then).not.toHaveBeenCalled()
  seedNewTask(then)
  await createTask({ title: 'T', branch: 't', components: [] })
  expect(then).toHaveBeenCalledExactlyOnceWith(task)
})

test('rapid highlights write only the latest scope without listing worktrees again', async () => {
  vi.useFakeTimers()
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    name: 'P',
    root: '/p',
    schemaVersion: 4,
    links: [],
    components: [
      {
        id: 'web',
        name: 'Web',
        path: '.',
        kind: 'app',
        notes: '',
        position: { x: 0, y: 0 },
        terminals: [],
      },
    ],
  })
  const task: Task = {
    id: 't',
    title: 'T',
    worktree: '/t',
    branch: 't',
    components: [],
    notes: '',
    createdMs: 1,
    missing: false,
    current: false,
  }
  useStore.getState().setTasks([task])
  useStore.getState().setActiveTask('t')
  vi.mocked(taskUpdate).mockResolvedValue({ ...task, components: ['web'] })
  stop = followActiveTask()
  useStore.setState({ highlighted: ['web'] })
  await vi.advanceTimersByTimeAsync(150)
  useStore.setState({ highlighted: [] })
  await vi.advanceTimersByTimeAsync(150)
  useStore.setState({ highlighted: ['web'] })
  expect(taskUpdate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(250)
  expect(taskUpdate).toHaveBeenCalledTimes(1)
  expect(taskUpdate).toHaveBeenCalledWith('t', { components: ['web'] }, 'p')
  expect(taskList).not.toHaveBeenCalled()
  expect(useStore.getState().tasks[0].components).toEqual(['web'])
})
