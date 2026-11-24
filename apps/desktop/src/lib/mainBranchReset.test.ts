import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { projectStateOf, useStore, workspaceOf } from '../store'
import type { AutoRun, Project, SessionRecord } from '../types'
import { completeTeamTask } from './chatTeams'
import { mergeOutcome, planRead, planWrite, terminalStop } from './ipc'
import { reconcileMainBranch } from './mainBranchReset'
import { trackMergeCleanup } from './mergeCleanup'
import type { SimpleState } from './simple'

vi.mock('./ipc', () => ({
  planRead: vi.fn(),
  planWrite: vi.fn(),
  terminalStop: vi.fn().mockResolvedValue(undefined),
  mergeOutcome: vi.fn().mockResolvedValue('merged'),
  gitWorktrees: vi.fn().mockResolvedValue([]),
}))
vi.mock('./chatTeams', () => ({
  completeTeamTask: vi.fn().mockResolvedValue(undefined),
  teamFor: vi.fn(),
  forgetTeamChat: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./workspace', () => ({ flushWorkspace: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./sessions', () => ({ reconcileFreshSessions: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./tasks', () => ({ refreshTasks: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./git', () => ({ requestGitRefresh: vi.fn().mockResolvedValue(undefined) }))

const project: Project = {
  schemaVersion: 4,
  projectId: 'p',
  name: 'P',
  root: '/p',
  components: [],
  links: [],
  groups: [],
}
const main = () => workspaceOf(projectStateOf('p')!, null)
const simple = () => main().simple as SimpleState
const setSimple = (value: SimpleState) =>
  useStore.getState().patchTask('p', null, { simple: value })
const agent = (id: string, scope: string, state: string, startedMs = 1): SessionRecord =>
  ({
    id,
    metadata: { projectId: 'p', componentId: scope, kind: 'agent' },
    spec: { cwd: '/p' },
    snapshot: { running: true, startedMs, status: { agent: { state } } },
    history: [],
  }) as unknown as SessionRecord

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject(project)
  useStore.setState({ restoring: false, sessions: {}, sessionRecords: [], workspaceSettings: {} })
  vi.mocked(planRead).mockResolvedValue({ text: 'Old plan', cut: false, savedMs: 1 })
  vi.mocked(planWrite).mockResolvedValue(true)
  vi.mocked(mergeOutcome).mockResolvedValue('merged')
})
afterEach(() => {
  vi.useRealTimers()
})
const mergeJob = (sourceBranch = 'feature', destinationBranch = 'main', id = 'job') =>
  trackMergeCleanup(
    project,
    { source: '/p', sourceBranch, destination: '/m', destinationBranch },
    'merge',
    id,
    'keep',
    false,
  )

test('records the branch without resetting a chat that starts on it', async () => {
  await reconcileMainBranch('p', 'main')
  expect(simple()).toMatchObject({ branch: 'main', startedMs: 0, log: [] })
  expect(simple().workflowResetMs).toBeUndefined()
  expect(completeTeamTask).not.toHaveBeenCalled()
})

test.each([
  ['main', 'feature'],
  ['feature', 'other'],
])('a switch from %s to %s only records the branch', async (from, to) => {
  setSimple({ startedMs: 0, log: [], branch: from })
  await reconcileMainBranch('p', to)
  expect(simple().branch).toBe(to)
  expect(simple().workflowResetMs).toBeUndefined()
  expect(planWrite).not.toHaveBeenCalled()
})

test('a detached HEAD during a rebase keeps the stored branch', async () => {
  setSimple({ startedMs: 0, log: [], branch: 'feature' })
  await reconcileMainBranch('p', 'detached abc1234')
  expect(simple().branch).toBe('feature')
})

test('a return to main resets stage, history, plan, Auto and the lead once', async () => {
  setSimple({
    startedMs: 0,
    branch: 'feature',
    log: [{ id: 'a', kind: 'action', action: 'merge', stage: 'merge', atMs: 5 }],
  })
  useStore
    .getState()
    .patchTask('p', null, { auto: { status: 'done', log: [{ atMs: 5 }] } as unknown as AutoRun })
  useStore.setState({
    sessionRecords: [
      agent('builder', '@task', 'idle'),
      agent('busy', '@task', 'working'),
      agent('chat', '@map', 'idle'),
    ],
  })
  await reconcileMainBranch('p', 'main')
  const reset = simple()
  expect(reset.branch).toBe('main')
  expect(reset.workflowResetMs).toBeGreaterThan(0)
  expect(reset.log).toEqual([])
  expect(reset.clearBoundary?.atMs).toBe(reset.workflowResetMs)
  expect(reset.branchReset).toBeUndefined()
  expect(main().auto).toBeNull()
  expect(planWrite).toHaveBeenCalledWith('p', undefined, '', 'Old plan')
  expect(terminalStop).toHaveBeenCalledTimes(1)
  expect(terminalStop).toHaveBeenCalledWith('builder')
  expect(completeTeamTask).toHaveBeenCalledWith(
    'p',
    null,
    `branch-reset-${reset.workflowResetMs}`,
    reset.workflowResetMs,
  )
  await reconcileMainBranch('p', 'main')
  expect(completeTeamTask).toHaveBeenCalledTimes(1)
})

test('a switch made while the app was closed resets on the first read', async () => {
  setSimple({ startedMs: 0, log: [], branch: 'feature' })
  await reconcileMainBranch('p', 'master')
  expect(simple().workflowResetMs).toBeGreaterThan(0)
})

test('waits for a restoration before comparing branches', async () => {
  setSimple({ startedMs: 0, log: [], branch: 'feature' })
  useStore.setState({ restoring: true })
  await reconcileMainBranch('p', 'main')
  expect(simple().branch).toBe('feature')
})

test('the plan clear waits for a running main planner and is retried', async () => {
  setSimple({ startedMs: 0, log: [], branch: 'feature' })
  const planner = agent('planner', '@plan', 'working')
  planner.metadata.task = '_worktree_main'
  useStore.setState({ sessionRecords: [planner] })
  await reconcileMainBranch('p', 'main')
  expect(planWrite).not.toHaveBeenCalled()
  expect(simple().branchReset?.pending).toEqual(['plan'])
  const atMs = simple().workflowResetMs
  useStore.setState({ sessionRecords: [], sessions: {} })
  await reconcileMainBranch('p', 'main')
  expect(planWrite).toHaveBeenCalledTimes(1)
  expect(simple().branchReset).toBeUndefined()
  // A retry never restarts the reset or the lead.
  expect(simple().workflowResetMs).toBe(atMs)
  expect(completeTeamTask).toHaveBeenCalledTimes(1)
})

test('a plan saved since the reset, or an idle old planner, never blocks or loses the next plan', async () => {
  setSimple({ startedMs: 0, log: [], branch: 'feature' })
  const planner = agent('planner', '@plan', 'idle')
  planner.metadata.task = '_worktree_main'
  useStore.setState({ sessionRecords: [planner] })
  vi.mocked(planRead).mockResolvedValue({
    text: 'Next plan',
    cut: false,
    savedMs: Date.now() + 1000,
  })
  await reconcileMainBranch('p', 'main')
  expect(planWrite).not.toHaveBeenCalled()
  expect(simple().branchReset).toBeUndefined()
})

test('a failed lead reset backs off, then is retried with the same id', async () => {
  vi.useFakeTimers()
  setSimple({ startedMs: 0, log: [], branch: 'feature' })
  vi.mocked(completeTeamTask).mockRejectedValueOnce(new Error('offline'))
  await reconcileMainBranch('p', 'main')
  expect(simple().branchReset?.pending).toEqual(['lead'])
  // Session updates during the backoff don't retry it.
  await reconcileMainBranch('p', 'main')
  expect(completeTeamTask).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2_000)
  await reconcileMainBranch('p', 'main')
  const ids = vi.mocked(completeTeamTask).mock.calls.map((c) => c[2])
  expect(ids).toHaveLength(2)
  expect(ids[0]).toBe(ids[1])
  expect(simple().branchReset).toBeUndefined()
})

test('merge cleanup of this branch already gives the lead its fresh conversation', async () => {
  setSimple({ startedMs: 0, log: [], branch: 'feature' })
  mergeJob()
  await reconcileMainBranch('p', 'main')
  expect(completeTeamTask).not.toHaveBeenCalled()
  expect(simple().branchReset).toBeUndefined()
})

test.each([
  ['another branch', () => mergeJob('earlier')],
  ['a merge into another branch', () => mergeJob('feature', 'develop')],
  [
    'an aborted merge',
    () => {
      mergeJob()
      vi.mocked(mergeOutcome).mockResolvedValue('notMerged')
    },
  ],
])('a cleanup job for %s leaves the lead reset to the return', async (_, track) => {
  setSimple({ startedMs: 0, log: [], branch: 'feature' })
  track()
  await reconcileMainBranch('p', 'main')
  expect(completeTeamTask).toHaveBeenCalledTimes(1)
})

test('the lead and its sub-builders keep running', async () => {
  setSimple({ startedMs: 0, log: [], branch: 'feature' })
  useStore.setState({
    sessionRecords: [
      agent('lead', '@coordinator', 'idle'),
      agent('worker', '@worker', 'idle'),
      agent('reviewer', '@review', 'idle'),
      agent('merger', '@merge', 'idle'),
      agent('component', 'crates-core', 'idle'),
    ],
  })
  await reconcileMainBranch('p', 'main')
  expect(
    vi
      .mocked(terminalStop)
      .mock.calls.map((c) => c[0])
      .sort(),
  ).toEqual(['merger', 'reviewer'])
})
