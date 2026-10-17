import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import type { AutoRun, Task } from '../types'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'main' }),
}))
vi.mock('./ipc', () => ({
  gitBranches: vi.fn(async () => ['main', 'n']),
  gitReview: vi.fn(async () => ({ ahead: false, changes: {}, affected: [] })),
  gitWorktrees: vi.fn(async () => [
    { path: '/p', branch: 'main', head: 'a', current: true, main: true },
    { path: '/p-n', branch: 'n', head: 'a', current: false, main: false },
  ]),
  mergeOutcome: vi.fn(),
  planRead: vi.fn(async (_projectId: string, task?: string) => ({
    text: task ? '' : '# Planned goal\n\nDo the work.',
    cut: false,
  })),
  proposalRead: vi.fn(async () => null),
  reviewRead: vi.fn(async () => null),
  taskActivate: vi.fn(async () => {}),
  taskAttach: vi.fn(),
  taskCreate: vi.fn(),
  taskList: vi.fn(),
}))
vi.mock('./git', () => ({ invalidateGitRefresh: vi.fn(), requestGitRefresh: vi.fn() }))
vi.mock('./sessions', () => ({
  startTerminal: vi.fn(),
  reconcileFreshSessions: vi.fn(async () => {}),
  listenForTerminals: vi.fn(),
  refreshSession: vi.fn(),
}))
vi.mock('./planHandoff', () => ({ implementPlannerPlan: vi.fn() }))
vi.mock('./reviewHandoff', () => ({ fixReviewFindings: vi.fn() }))
const { seedAutoTask } = await import('./autoWorktree')
const { autoDraftKey, autoDrafts, emptyAutoDraft } = await import('./autoDrafts')
const { createTask, attachTask } = await import('./tasks')
const { autoSnapshot } = await import('./auto')
const ipc = await import('./ipc')

const created: Task = {
  id: 'n',
  title: 'N',
  worktree: '/p-n',
  branch: 'n',
  components: [],
  notes: '',
  createdMs: 1,
  missing: false,
  current: false,
}
const run: AutoRun = {
  runId: '',
  status: 'running',
  stage: 'plan',
  goal: '',
  effort: 'standard',
  merge: { mode: 'ask', destinationBranch: '' },
  device: '',
  round: 0,
  log: [],
}
const folder = autoDraftKey('p', null)
const target = autoDraftKey('p', 'n')

const open = (id: string) =>
  useStore.getState().loadProject({
    projectId: id,
    root: `/${id}`,
    name: id.toUpperCase(),
    schemaVersion: 4,
    links: [],
    components: [],
  })

beforeEach(() => {
  vi.clearAllMocks()
  autoDrafts.clear()
  useStore.setState(useStore.getInitialState())
  open('p')
  useStore.setState({ restoring: false })
  vi.mocked(ipc.taskCreate).mockResolvedValue(created)
  vi.mocked(ipc.taskList).mockResolvedValue([created])
})

test("a worktree from Auto's prompt takes the project plan as its goal", async () => {
  // Outside Plan, as the dialog is in Navigation, the prompt still marks the worktree.
  expect(useStore.getState().view).toBe('navigation')
  seedAutoTask(folder, '')
  expect(useStore.getState().newTask?.title).toBeUndefined()
  await createTask({ title: 'N', branch: 'n', components: [] })
  expect(useStore.getState().activeTask).toBe('n')
  expect(useStore.getState().plannedFromProject).toBe(true)
  expect(autoDrafts.has(target)).toBe(false)
  expect((await autoSnapshot('p', 'n', run, true)).goal).toBe('Planned goal')
  expect(useStore.getState().autoPanelRequest).toBe(1)
})

test('a typed goal titles the worktree and moves to its draft with the other choices', async () => {
  autoDrafts.set(folder, { ...emptyAutoDraft(), effort: 'thorough', destination: 'main' })
  seedAutoTask(folder, '  Typed goal\nmore  ')
  expect(useStore.getState().newTask?.title).toBe('Typed goal')
  await createTask({ title: 'N', branch: 'n', components: [] })
  expect(autoDrafts.has(folder)).toBe(false)
  expect(autoDrafts.get(target)).toMatchObject({
    effort: 'thorough',
    goal: 'Typed goal\nmore',
    destination: undefined,
  })
})

test("an existing worktree's own draft is kept, and so is the project folder's", async () => {
  const own = { ...emptyAutoDraft(), goal: 'Its own goal' }
  autoDrafts.set(target, own)
  autoDrafts.set(folder, { ...emptyAutoDraft(), goal: 'Folder goal' })
  seedAutoTask(folder, 'Folder goal')
  vi.mocked(ipc.taskAttach).mockResolvedValue(created)
  await attachTask('/p-n', [])
  expect(autoDrafts.get(target)).toBe(own)
  expect(autoDrafts.get(folder)?.goal).toBe('Folder goal')
})

test('the Auto panel opens only while the new worktree is still the active one', async () => {
  open('q')
  useStore.getState().activateProject('p')
  vi.mocked(ipc.taskCreate).mockImplementation(async () => {
    useStore.getState().activateProject('q')
    return created
  })
  seedAutoTask(folder, 'Goal')
  await createTask({ title: 'N', branch: 'n', components: [] })
  expect(useStore.getState().project?.id).toBe('q')
  expect(useStore.getState().autoPanelRequest).toBe(0)
  // The worktree still borrows the plan in its own project.
  expect(useStore.getState().captureProjects().p.state?.plannedFromProject).toBe(true)
})
