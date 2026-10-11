import { afterEach, expect, test, vi } from 'vitest'
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
}))
vi.mock('./git', () => ({ invalidateGitRefresh: vi.fn(), requestGitRefresh: vi.fn() }))
const { followActiveTask } = await import('./tasks')
const { taskUpdate, taskList } = await import('./ipc')

let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
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
