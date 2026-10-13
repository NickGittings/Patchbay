import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import { REVIEW_SCOPE, TASK_ROOT_SCOPE, type DeviceManifest, type SessionRecord } from '../types'

vi.mock('../store', () => ({ useStore: { getState: vi.fn() } }))
vi.mock('./ipc', () => ({ gitWorktrees: vi.fn() }))
vi.mock('./sessions', () => ({ startTerminal: vi.fn() }))
const { gitWorktrees } = await import('./ipc')
const { startTerminal } = await import('./sessions')
const { fixReviewFindings, reviewerDevice } = await import('./reviewHandoff')
const claude: DeviceManifest = {
  id: 'claude',
  name: 'Claude',
  command: 'claude',
  adapter: 'claude',
  category: 'agent',
  kind: 'agent',
  source: 'builtin',
}
const codex: DeviceManifest = {
  ...claude,
  id: 'codex',
  name: 'Codex',
  command: 'codex',
  adapter: 'codex',
}
const record: SessionRecord = {
  id: 'review',
  metadata: {
    projectId: 'p',
    projectRoot: '/p',
    projectName: 'Project',
    componentId: REVIEW_SCOPE,
    terminalId: 'review-slot',
    name: 'Review',
    kind: 'agent',
    adapter: 'codex',
    branch: 'feature',
    conversationId: null,
  },
  spec: { cwd: '/feature', command: 'codex -c developer_instructions=x' },
  snapshot: null,
  history: [],
  interrupted: false,
}
const fix = { kind: 'fixFindings', reviewBranch: 'feature' }
const feature = { id: 'feature', worktree: '/feature', missing: false, current: false }
const state = {
  project: { id: 'p', root: '/p' },
  activeTask: null as string | null,
  tasks: [feature] as (typeof feature)[],
  devices: [claude, codex],
  setActiveTask: vi.fn((task: string | null) => {
    if (state.tasks.some((t) => t.id === task && t.missing)) return
    state.activeTask = task
  }),
  addRootTerminal: vi.fn(() => 'fix-agent'),
  setView: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(startTerminal).mockReset()
  vi.mocked(gitWorktrees).mockResolvedValue([])
  state.project = { id: 'p', root: '/p' }
  state.activeTask = null
  state.tasks = [feature]
  state.devices = [claude, codex]
  vi.mocked(useStore.getState).mockImplementation(
    () => state as unknown as ReturnType<typeof useStore.getState>,
  )
})

test('resolves a task from the review cwd and switches before creating a fresh root agent', async () => {
  await fixReviewFindings(record)
  expect(state.setActiveTask).toHaveBeenCalledWith('feature')
  expect(state.addRootTerminal).toHaveBeenCalledWith(codex)
  expect(state.setActiveTask.mock.invocationCallOrder[0]).toBeLessThan(
    state.addRootTerminal.mock.invocationCallOrder[0],
  )
  expect(startTerminal).toHaveBeenCalledWith(TASK_ROOT_SCOPE, 'fix-agent', 'feature', 'p', fix)
  expect(state.setView).toHaveBeenCalledWith('implementation')
})

test('a project folder attached as a task launches in that task', async () => {
  state.tasks = [{ ...feature, current: true }]
  state.activeTask = 'feature'
  await fixReviewFindings(record)
  expect(state.setActiveTask).not.toHaveBeenCalled()
  expect(startTerminal).toHaveBeenCalledWith(TASK_ROOT_SCOPE, 'fix-agent', 'feature', 'p', fix)
})

test('the open worktree resolves to the project folder when the project is in a subfolder', async () => {
  state.tasks = []
  state.activeTask = 'other'
  state.project.root = '/feature/app'
  vi.mocked(gitWorktrees).mockResolvedValue([
    { path: '/feature', branch: 'feature', head: 'abc', main: true, current: true },
  ])
  await fixReviewFindings(record)
  expect(state.setActiveTask).toHaveBeenCalledWith(null)
  expect(startTerminal).toHaveBeenCalledWith(TASK_ROOT_SCOPE, 'fix-agent', null, 'p', fix)
})

test('an unknown worktree must be added as a task', async () => {
  await expect(
    fixReviewFindings({ ...record, spec: { ...record.spec, cwd: '/unknown' } }),
  ).rejects.toThrow('Add this worktree as a task first')
  expect(state.setActiveTask).not.toHaveBeenCalled()
  expect(startTerminal).not.toHaveBeenCalled()
})

test('a missing worktree is reported as missing', async () => {
  state.tasks = [{ ...feature, missing: true }]
  await expect(fixReviewFindings(record)).rejects.toThrow('no longer exists')
  expect(startTerminal).not.toHaveBeenCalled()
})

test('a review without a recorded branch cannot be fixed', async () => {
  await expect(
    fixReviewFindings({ ...record, metadata: { ...record.metadata, branch: null } }),
  ).rejects.toThrow('start a new review')
  expect(startTerminal).not.toHaveBeenCalled()
})

test('an already active task is not switched again', async () => {
  state.activeTask = 'feature'
  await fixReviewFindings(record)
  expect(state.setActiveTask).not.toHaveBeenCalled()
})

test('without agent presets the fallback agent launches', async () => {
  state.devices = []
  await fixReviewFindings(record)
  expect(state.addRootTerminal).toHaveBeenCalledWith(expect.objectContaining({ command: 'claude' }))
})

test('the reviewer preset wins over other presets of its provider', () => {
  const opus = { ...claude, id: 'opus', command: 'claude --model opus', adapter: undefined }
  const review = {
    ...record,
    metadata: { ...record.metadata, adapter: 'claude' as const },
    spec: { ...record.spec, command: 'claude --model opus --append-system-prompt-file /b.md' },
  }
  expect(reviewerDevice([claude, opus], review)).toBe(opus)
  expect(reviewerDevice([codex, claude], { ...review, spec: { cwd: '/', command: 'x' } })).toBe(
    claude,
  )
})

test('a launch failure leaves the view unchanged and propagates the error', async () => {
  vi.mocked(startTerminal).mockRejectedValue(new Error('Launch failed'))
  await expect(fixReviewFindings(record)).rejects.toThrow('Launch failed')
  expect(state.setView).not.toHaveBeenCalled()
})

test('a task switch during launch keeps the started agent and the current view', async () => {
  vi.mocked(startTerminal).mockImplementation(async () => {
    state.activeTask = 'other'
  })
  await fixReviewFindings(record)
  expect(startTerminal).toHaveBeenCalledTimes(1)
  expect(state.setView).not.toHaveBeenCalled()
})

test('a project switch during launch keeps the current view', async () => {
  vi.mocked(startTerminal).mockImplementation(async () => {
    state.project.id = 'other'
  })
  await fixReviewFindings(record)
  expect(state.setView).not.toHaveBeenCalled()
})

test('a review from another project cannot launch here', async () => {
  state.project.id = 'other'
  await expect(fixReviewFindings(record)).rejects.toThrow('Open the reviewed project first')
  expect(startTerminal).not.toHaveBeenCalled()
})
