import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import type { Task } from '../types'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'main' }),
}))
vi.mock('./ipc', () => ({
  taskUpdate: vi.fn(),
  taskList: vi.fn(),
  taskActivate: vi.fn(async () => {}),
  taskCreate: vi.fn(),
  taskRemove: vi.fn(async () => true),
}))
vi.mock('./git', () => ({ invalidateGitRefresh: vi.fn(), requestGitRefresh: vi.fn() }))
vi.mock('./sessions', () => ({ reconcileFreshSessions: vi.fn(async () => {}) }))
const { cancelNewTask, createTask, followActiveTask, seedNewTask, removeTask } =
  await import('./tasks')
const { taskCreate, taskUpdate, taskList, taskRemove } = await import('./ipc')
const { reconcileFreshSessions } = await import('./sessions')

let stop: (() => void) | undefined
beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
  cancelNewTask()
})

function removalProject(activeTask: string | null = 't') {
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    name: 'P',
    root: '/p',
    schemaVersion: 4,
    links: [],
    components: [],
  })
  const task = { id: 't', title: 'T', components: [] } as unknown as Task
  useStore.getState().setTasks([task])
  useStore.getState().setActiveTask(activeTask)
  // The backend still lists a task it refused to remove.
  vi.mocked(taskList).mockResolvedValue([task])
}

test.each([true, false])(
  'removal (%s) refreshes tasks and sessions after it succeeds',
  async (remove) => {
    removalProject()
    await removeTask('t', remove)
    expect(taskRemove).toHaveBeenCalledWith('t', remove, 'p')
    expect(vi.mocked(taskRemove).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(reconcileFreshSessions).mock.invocationCallOrder[0],
    )
    expect(useStore.getState().activeTask).toBeNull()
    expect(useStore.getState().message).toBeFalsy()
  },
)

test('a refused removal keeps the active worktree and still refreshes tasks', async () => {
  removalProject()
  vi.mocked(taskRemove).mockRejectedValueOnce(new Error('dirty worktree'))
  await expect(removeTask('t', true)).rejects.toThrow('dirty worktree')
  expect(reconcileFreshSessions).not.toHaveBeenCalled()
  expect(useStore.getState().activeTask).toBe('t')
  expect(taskList).toHaveBeenCalledWith('p')
})

test('a failed session refresh does not fail a successful removal', async () => {
  removalProject()
  vi.mocked(reconcileFreshSessions).mockRejectedValueOnce(new Error('disconnected'))
  await expect(removeTask('t', true)).resolves.toBeUndefined()
})

test('sessions the backend could not forget are reported', async () => {
  removalProject()
  vi.mocked(taskRemove).mockResolvedValueOnce(false)
  await removeTask('t', true)
  expect(useStore.getState().message).toMatch(/could not be cleared/)
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
  seedNewTask(then, 'Optimize tokens')
  expect(useStore.getState().newTask?.title).toBe('Optimize tokens')
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
