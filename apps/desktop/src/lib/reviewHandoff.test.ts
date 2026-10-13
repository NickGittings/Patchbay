import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import { REVIEW_SCOPE, TASK_ROOT_SCOPE, type DeviceManifest, type SessionRecord } from '../types'

vi.mock('../store', () => ({ useStore: { getState: vi.fn() } }))
vi.mock('./ipc', () => ({ reviewFixTask: vi.fn() }))
vi.mock('./sessions', () => ({ startTerminal: vi.fn() }))
const { reviewFixTask } = await import('./ipc')
const { startTerminal } = await import('./sessions')
const { fixReviewFindings } = await import('./reviewHandoff')
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
  spec: { cwd: '/feature', command: 'codex' },
  snapshot: null,
  history: [],
  interrupted: false,
}
const fix = { kind: 'fixFindings', reviewSession: 'review' }
const state = {
  project: { id: 'p', root: '/p' },
  activeTask: null as string | null,
  devices: [claude, codex],
  setActiveTask: vi.fn((task: string | null, _exact?: boolean) => {
    state.activeTask = task
  }),
  addRootTerminal: vi.fn(() => 'fix-agent'),
  setView: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(startTerminal).mockReset()
  vi.mocked(reviewFixTask).mockResolvedValue('feature')
  state.project = { id: 'p', root: '/p' }
  state.activeTask = null
  state.devices = [claude, codex]
  vi.mocked(useStore.getState).mockImplementation(
    () => state as unknown as ReturnType<typeof useStore.getState>,
  )
})

test('switches to the task the backend resolves before creating a fresh root agent', async () => {
  await fixReviewFindings(record)
  expect(reviewFixTask).toHaveBeenCalledWith('review', 'p')
  expect(state.setActiveTask).toHaveBeenCalledWith('feature', true)
  expect(state.addRootTerminal).toHaveBeenCalledWith(codex)
  expect(state.setActiveTask.mock.invocationCallOrder[0]).toBeLessThan(
    state.addRootTerminal.mock.invocationCallOrder[0],
  )
  expect(startTerminal).toHaveBeenCalledWith(TASK_ROOT_SCOPE, 'fix-agent', 'feature', 'p', fix)
  expect(state.setView).toHaveBeenCalledWith('implementation')
})

test('the project folder is selected exactly, without following an attached task', async () => {
  vi.mocked(reviewFixTask).mockResolvedValue(null)
  state.activeTask = 'other'
  await fixReviewFindings(record)
  expect(state.setActiveTask).toHaveBeenCalledWith(null, true)
  expect(startTerminal).toHaveBeenCalledWith(TASK_ROOT_SCOPE, 'fix-agent', null, 'p', fix)
})

test('a backend refusal stops before switching or launching', async () => {
  vi.mocked(reviewFixTask).mockRejectedValue(new Error('Add this worktree as a task first'))
  await expect(fixReviewFindings(record)).rejects.toThrow('Add this worktree as a task first')
  expect(state.setActiveTask).not.toHaveBeenCalled()
  expect(startTerminal).not.toHaveBeenCalled()
})

test('a task that cannot be activated stops before launching', async () => {
  state.setActiveTask.mockImplementationOnce(() => {})
  await expect(fixReviewFindings(record)).rejects.toThrow("Couldn't switch")
  expect(startTerminal).not.toHaveBeenCalled()
})

test('an already active task is not switched again', async () => {
  state.activeTask = 'feature'
  await fixReviewFindings(record)
  expect(state.setActiveTask).not.toHaveBeenCalled()
})

test('falls back to the first agent preset when the reviewer provider is unavailable', async () => {
  state.devices = [{ ...codex, kind: 'shell' }, claude]
  await fixReviewFindings(record)
  expect(state.addRootTerminal).toHaveBeenCalledWith(claude)
})

test('without agent presets the fallback agent launches', async () => {
  state.devices = []
  await fixReviewFindings(record)
  expect(state.addRootTerminal).toHaveBeenCalledWith(expect.objectContaining({ command: 'claude' }))
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

test('a project switch while resolving the task stops before launching', async () => {
  vi.mocked(reviewFixTask).mockImplementation(async () => {
    state.project.id = 'other'
    return 'feature'
  })
  await expect(fixReviewFindings(record)).rejects.toThrow('Open the reviewed project first')
  expect(startTerminal).not.toHaveBeenCalled()
})

test('a review from another project cannot launch here', async () => {
  state.project.id = 'other'
  await expect(fixReviewFindings(record)).rejects.toThrow('Open the reviewed project first')
  expect(reviewFixTask).not.toHaveBeenCalled()
})
