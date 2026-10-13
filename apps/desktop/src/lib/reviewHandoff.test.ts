import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import { REVIEW_SCOPE, TASK_ROOT_SCOPE, type DeviceManifest, type SessionRecord } from '../types'

vi.mock('../store', () => ({ useStore: { getState: vi.fn() } }))
vi.mock('./ipc', () => ({}))
vi.mock('./sessions', () => ({ startTerminal: vi.fn() }))
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
    terminalId: 'review',
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
const state = {
  project: { id: 'p', root: '/p' },
  activeTask: null as string | null,
  tasks: [{ id: 'feature', worktree: '/feature' }],
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
  state.project = { id: 'p', root: '/p' }
  state.activeTask = null
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
  expect(startTerminal).toHaveBeenCalledWith(
    TASK_ROOT_SCOPE,
    'fix-agent',
    'feature',
    'p',
    'fixFindings',
  )
  expect(state.setView).toHaveBeenCalledWith('implementation')
})

test('the project root resolves to null even when it is listed as a task', async () => {
  state.project.root = '/feature'
  state.activeTask = 'feature'
  await fixReviewFindings(record)
  expect(state.setActiveTask).toHaveBeenCalledWith(null, true)
  expect(startTerminal).toHaveBeenCalledWith(TASK_ROOT_SCOPE, 'fix-agent', null, 'p', 'fixFindings')
})

test('an unknown worktree must be added as a task', async () => {
  await expect(
    fixReviewFindings({ ...record, spec: { ...record.spec, cwd: '/unknown' } }),
  ).rejects.toThrow('Add this worktree as a task first')
  expect(state.setActiveTask).not.toHaveBeenCalled()
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

test('no installed agent presets prevents launch', async () => {
  state.devices = []
  await expect(fixReviewFindings(record)).rejects.toThrow('No agent presets')
  expect(startTerminal).not.toHaveBeenCalled()
})

test('a launch failure leaves the view unchanged and propagates the error', async () => {
  vi.mocked(startTerminal).mockRejectedValue(new Error('Launch failed'))
  await expect(fixReviewFindings(record)).rejects.toThrow('Launch failed')
  expect(state.setView).not.toHaveBeenCalled()
})

test('a task switch during launch prevents a view switch', async () => {
  vi.mocked(startTerminal).mockImplementation(async () => {
    state.activeTask = 'other'
  })
  await expect(fixReviewFindings(record)).rejects.toThrow('The task changed')
  expect(state.setView).not.toHaveBeenCalled()
})

test('a project switch during launch prevents a view switch', async () => {
  vi.mocked(startTerminal).mockImplementation(async () => {
    state.project.id = 'other'
  })
  await expect(fixReviewFindings(record)).rejects.toThrow('The task changed')
  expect(state.setView).not.toHaveBeenCalled()
})

test('a review from another project cannot launch here', async () => {
  state.project.id = 'other'
  await expect(fixReviewFindings(record)).rejects.toThrow('Open the reviewed project first')
  expect(startTerminal).not.toHaveBeenCalled()
})
