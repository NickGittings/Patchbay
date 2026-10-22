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
  taskAttach: vi.fn(),
  taskRemove: vi.fn(async () => true),
  planRead: vi.fn(async () => ({ text: '', cut: false })),
  planWrite: vi.fn(async () => true),
}))
vi.mock('./git', () => ({ invalidateGitRefresh: vi.fn(), requestGitRefresh: vi.fn() }))
vi.mock('./sessions', () => ({ reconcileFreshSessions: vi.fn(async () => {}) }))
const {
  attachTask,
  branchFor,
  cancelNewTask,
  createTask,
  followActiveTask,
  seedNewTask,
  refreshTasks,
  removeTask,
  shortTitle,
  titleFor,
} = await import('./tasks')
const { autoDraftKey, autoDrafts, emptyAutoDraft } = await import('./autoDrafts')
const { planRead, planWrite, taskAttach, taskCreate, taskUpdate, taskList, taskRemove } =
  await import('./ipc')
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
  seedNewTask(then, { title: 'Optimize tokens' })
  expect(useStore.getState().newTask?.title).toBe('Optimize tokens')
  cancelNewTask()
  expect(useStore.getState().newTask).toBeNull()
  await createTask({ title: 'T', branch: 't', components: [] })
  expect(useStore.getState().activeTask).toBe('t')
  expect(then).not.toHaveBeenCalled()
  seedNewTask(then)
  await createTask({ title: 'T', branch: 't', components: [] })
  expect(then).toHaveBeenCalledExactlyOnceWith(task, 'p')
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

test("removing a worktree drops its Auto draft, not the project folder's", async () => {
  removalProject()
  autoDrafts.set(autoDraftKey('p', 't'), emptyAutoDraft())
  autoDrafts.set(autoDraftKey('p', null), emptyAutoDraft())
  await removeTask('t', true)
  expect(autoDrafts.has(autoDraftKey('p', 't'))).toBe(false)
  expect(autoDrafts.has(autoDraftKey('p', null))).toBe(true)
})

test('a goal seeds a short, single-line worktree title', () => {
  expect(titleFor('\n## Optimize tokens\n\nCut the briefing in half.')).toBe('Optimize tokens')
  expect(titleFor('   ')).toBe('')
  expect(shortTitle('Fix trends nutrition graphs. When navigating between timeframes it is')).toBe(
    'Fix trends nutrition graphs…',
  )
  expect(shortTitle('Fix login')).toBe('Fix login')
  expect(shortTitle('Fix login.')).toBe('Fix login')
  expect(shortTitle('Add a settings page for every user role')).toBe('Add a settings page…')
  expect(shortTitle('v1.2 release: notes')).toBe('v1.2 release: notes')
  expect(shortTitle('WIP: login flow')).toBe('WIP: login flow')
  expect(shortTitle('Fix login; then deploy it today')).toBe('Fix login; then deploy…')
  expect(shortTitle('Fix  login')).toBe('Fix login')
  expect(shortTitle('Ship it?!')).toBe('Ship it')
  expect(shortTitle('Ship it?! Then rest')).toBe('Ship it…')
  expect(shortTitle('Fix login\n\n')).toBe('Fix login')
  expect(shortTitle('Fix login\nwith details')).toBe('Fix login…')
  expect(shortTitle('Add a settings  page.')).toBe('Add a settings page')
  const long = titleFor('word '.repeat(40))
  expect(long.length).toBeLessThanOrEqual(72)
  expect(long).not.toMatch(/\s$/)
  expect(titleFor('x'.repeat(100))).toHaveLength(72)
})

test('a long title keeps a word ending at the limit and cuts a long word hard', () => {
  // The 73rd character is a space, so the 72nd ends a whole word.
  const exact = `${'a'.repeat(70)} b c`
  expect(titleFor(exact)).toBe(`${'a'.repeat(70)} b`)
  // A boundary that would leave only the first word cuts mid-word instead.
  const path = `Fix ${'apps/desktop/src/components/'.repeat(4)}`
  expect(titleFor(path)).toBe(path.slice(0, 72))
})

test('a removal that succeeded is cleaned up even when refreshing the list fails', async () => {
  removalProject()
  autoDrafts.set(autoDraftKey('p', 't'), emptyAutoDraft())
  vi.mocked(taskList).mockRejectedValue(new Error('offline'))
  await expect(removeTask('t', true)).resolves.toBeUndefined()
  expect(autoDrafts.has(autoDraftKey('p', 't'))).toBe(false)
  expect(useStore.getState().activeTask).toBeNull()
})

const fresh = { id: 'n', title: 'N', components: [] } as unknown as Task

test('a new worktree asked to copy the plan starts with the project plan, before its follow-up', async () => {
  removalProject(null)
  vi.mocked(taskCreate).mockResolvedValue(fresh)
  vi.mocked(taskList).mockResolvedValue([fresh])
  vi.mocked(planRead).mockResolvedValue({ text: '# Plan', cut: false })
  const then = vi.fn()
  seedNewTask(then, { copyPlan: true })
  await createTask({ title: 'N', branch: 'n', components: [] })
  expect(useStore.getState().activeTask).toBe('n')
  expect(planRead).toHaveBeenCalledWith('p')
  // Only into a worktree that has no plan yet.
  expect(planWrite).toHaveBeenCalledExactlyOnceWith('p', 'n', '# Plan', '')
  expect(then).toHaveBeenCalledExactlyOnceWith(fresh, 'p')
  expect(vi.mocked(planWrite).mock.invocationCallOrder[0]).toBeLessThan(
    then.mock.invocationCallOrder[0],
  )
})

test('an attached worktree, or one not asked to copy, keeps its own plan', async () => {
  removalProject(null)
  vi.mocked(planRead).mockResolvedValue({ text: '# Plan', cut: false })
  vi.mocked(taskAttach).mockResolvedValue(fresh)
  vi.mocked(taskList).mockResolvedValue([fresh])
  seedNewTask(undefined, { copyPlan: true })
  await attachTask('/p-n', [])
  vi.mocked(taskCreate).mockResolvedValue(fresh)
  // Outside Plan, and in Plan too: only the caller decides.
  useStore.getState().setView('plan')
  seedNewTask()
  await createTask({ title: 'N', branch: 'n', components: [] })
  expect(planRead).not.toHaveBeenCalled()
  expect(planWrite).not.toHaveBeenCalled()
})

test.each([
  ['empty', { text: '  \n', cut: false }],
  ['cut', { text: '# Long plan', cut: true }],
])('an %s project plan is not copied', async (_, plan) => {
  removalProject(null)
  vi.mocked(taskCreate).mockResolvedValue(fresh)
  vi.mocked(taskList).mockResolvedValue([fresh])
  vi.mocked(planRead).mockResolvedValue(plan)
  seedNewTask(undefined, { copyPlan: true })
  await createTask({ title: 'N', branch: 'n', components: [] })
  expect(planWrite).not.toHaveBeenCalled()
})

test('a failed copy keeps the new worktree and says so', async () => {
  removalProject(null)
  vi.mocked(taskCreate).mockResolvedValue(fresh)
  vi.mocked(taskList).mockResolvedValue([fresh])
  vi.mocked(planRead).mockResolvedValue({ text: '# Plan', cut: false })
  vi.mocked(planWrite).mockRejectedValueOnce(new Error('disk full'))
  const then = vi.fn()
  seedNewTask(then, { copyPlan: true })
  await expect(createTask({ title: 'N', branch: 'n', components: [] })).resolves.toBe(fresh)
  expect(useStore.getState().activeTask).toBe('n')
  expect(then).toHaveBeenCalledOnce()
  expect(useStore.getState().message).toMatch('could not be copied')
})

test('a cut title never splits an emoji', () => {
  // The 72nd code unit is the first half of the emoji's surrogate pair.
  const goal = `${'a'.repeat(71)}😀${'b'.repeat(10)}`
  const title = titleFor(goal)
  expect(title).toBe(`${'a'.repeat(71)}😀`)
  expect(title).not.toMatch(/[\uD800-\uDBFF]$/)
})

test('a worktree that left the task list takes its Auto draft along', async () => {
  removalProject()
  autoDrafts.set(autoDraftKey('p', 't'), emptyAutoDraft())
  autoDrafts.set(autoDraftKey('p', 'gone'), emptyAutoDraft())
  autoDrafts.set(autoDraftKey('p', null), emptyAutoDraft())
  autoDrafts.set(autoDraftKey('q', 'gone'), emptyAutoDraft())
  await refreshTasks('p')
  expect(autoDrafts.has(autoDraftKey('p', 't'))).toBe(true)
  expect(autoDrafts.has(autoDraftKey('p', 'gone'))).toBe(false)
  expect(autoDrafts.has(autoDraftKey('p', null))).toBe(true)
  expect(autoDrafts.has(autoDraftKey('q', 'gone'))).toBe(true)
})

test('branch names from titles stay short', () => {
  expect(branchFor('Fix login bug')).toBe('fix-login-bug')
  const branch = branchFor('Make the planner hand its plan over '.repeat(10))
  expect(branch.length).toBeLessThanOrEqual(60)
  expect(branch).not.toMatch(/^[-./]|[-./]$/)
})

test('a task list asked for before a later one is never applied', async () => {
  removalProject()
  let answer!: (tasks: Task[]) => void
  vi.mocked(taskList).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
  const stale = refreshTasks('p')
  // A worktree created meanwhile is listed by the later request, and gets a draft.
  const listed = [{ id: 't', components: [] }, fresh] as unknown as Task[]
  vi.mocked(taskList).mockResolvedValueOnce(listed)
  await refreshTasks('p')
  autoDrafts.set(autoDraftKey('p', 'n'), { ...emptyAutoDraft(), goal: 'Typed goal' })
  answer([{ id: 't', components: [] } as unknown as Task])
  await stale
  expect(useStore.getState().tasks.map((t) => t.id)).toEqual(['t', 'n'])
  expect(autoDrafts.get(autoDraftKey('p', 'n'))?.goal).toBe('Typed goal')
})

test('an earlier request waits for the latest list before returning', async () => {
  removalProject()
  let answer!: (tasks: Task[]) => void
  vi.mocked(taskList).mockResolvedValueOnce([])
  vi.mocked(taskList).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
  let done = false
  const earlier = refreshTasks('p').then(() => (done = true))
  const latest = refreshTasks('p')
  await new Promise((resolve) => setTimeout(resolve))
  expect(done).toBe(false)
  answer([fresh])
  await Promise.all([earlier, latest])
  expect(useStore.getState().tasks.map((t) => t.id)).toEqual(['n'])
})

test("a later request's failure still lets an earlier list land", async () => {
  removalProject()
  let answer!: (tasks: Task[]) => void
  vi.mocked(taskList).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
  const earlier = refreshTasks('p')
  vi.mocked(taskList).mockRejectedValueOnce(new Error('transient'))
  const later = refreshTasks('p')
  answer([fresh])
  await Promise.all([earlier, later])
  expect(useStore.getState().tasks.map((t) => t.id)).toEqual(['n'])
})
