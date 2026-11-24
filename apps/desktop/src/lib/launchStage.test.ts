import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('./simpleReview', () => ({
  startSimpleReview: vi.fn(async () => ({
    started: [{ sessionId: 'reviewer', requestId: 'request', lane: null }],
    errors: [],
    round: 'round',
  })),
}))
vi.mock('./reviewAgents', () => ({ startMerge: vi.fn() }))
vi.mock('./stageRecord', async () => ({
  ...(await vi.importActual<typeof import('./stageRecord')>('./stageRecord')),
  recordStageLaunch: vi.fn(async () => {}),
}))
vi.mock('./planHandoff', () => ({ implementPlannerPlan: vi.fn() }))
vi.mock('./ipc', () => ({
  gitWorktrees: vi.fn(async () => []),
  reviewFixTask: vi.fn(async () => null),
}))
vi.mock('./reviewHandoff', () => ({ fixReviewFindings: vi.fn() }))
import { useStore } from '../store'
import type { AutoRun, Project, Task } from '../types'
import { launchFix, launchMerge, launchReview, taskOfWorktree } from './launchStage'
import { fixReviewFindings } from './reviewHandoff'
import { startMerge } from './reviewAgents'
import { startSimpleReview } from './simpleReview'
import { recordStageLaunch } from './stageRecord'

const project = { projectId: 'p' } as Project
const request = { worktree: '/p/w', branch: 'feature', base: 'main' }
beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState(useStore.getInitialState())
  useStore.setState({
    project: { id: 'p', name: 'P', root: '/p' },
    tasks: [{ id: 't', worktree: '/p/w' } as Task],
  })
})

test('the project folder is no task, and a worktree Patchbay doesn’t know has no chat', () => {
  expect(taskOfWorktree({ path: '/p' })).toBeNull()
  expect(taskOfWorktree({ path: '/p/w' })).toBe('t')
  expect(taskOfWorktree({ path: '/elsewhere' })).toBeUndefined()
})

test('git’s main worktree is the project folder even when its path differs from the root', () => {
  expect(taskOfWorktree({ path: '/repo', main: true })).toBeNull()
})

test('a project folder attached as a task records in that task’s chat', () => {
  useStore.setState({ tasks: [{ id: 'root-task', worktree: '/p', current: true } as Task] })
  expect(taskOfWorktree({ path: '/p' })).toBe('root-task')
})

test('a review or merge of a worktree without a chat runs but is recorded nowhere', async () => {
  await launchReview('manual', project, undefined, request, [])
  expect(startSimpleReview).toHaveBeenCalledOnce()
  vi.mocked(startMerge).mockResolvedValue({
    kind: 'started',
    sessionId: 'merger',
    requestId: 'merge-request',
    request: { source: '/x', sourceBranch: 'x', destination: '/p', destinationBranch: 'main' },
  })
  await launchMerge('manual', undefined, {
    project,
    source: { path: '/x', branch: 'x', head: 'h', main: false, current: false },
    destinationBranch: 'main',
    device: {} as never,
  })
  expect(startMerge).toHaveBeenCalledOnce()
  expect(recordStageLaunch).not.toHaveBeenCalled()
})

test.each(['running', 'waitingOnYou'] as const)(
  'a review never replaces the reviewers of an Auto run that is %s',
  async (status) => {
    useStore.setState({ auto: { status } as AutoRun, activeTask: null })
    await expect(launchReview('manual', project, null, request, [])).rejects.toThrow('Auto')
    expect(startSimpleReview).not.toHaveBeenCalled()
  },
)

test('a review after Auto finished starts and is recorded', async () => {
  useStore.setState({ auto: { status: 'done' } as AutoRun, activeTask: null })
  await launchReview('chat', project, null, request, [])
  expect(recordStageLaunch).toHaveBeenCalledWith(
    expect.objectContaining({ origin: 'chat', action: 'review', task: null }),
  )
})

test('fixes and merges also wait for a running Auto run, which says how it holds the worktree', async () => {
  useStore.setState({ auto: { status: 'waitingOnYou' } as AutoRun, activeTask: null })
  const reviewer = { metadata: { projectId: 'p' }, spec: { cwd: '/p' } } as never
  await expect(launchFix('manual', reviewer, 'follow')).rejects.toThrow('Auto is waiting for input')
  expect(fixReviewFindings).not.toHaveBeenCalled()
  await expect(
    launchMerge('manual', null, {
      project,
      source: { path: '/p', branch: 'x', head: 'h', main: true, current: true },
      destinationBranch: 'main',
      device: {} as never,
    }),
  ).rejects.toThrow('Open the run to continue')
  expect(startMerge).not.toHaveBeenCalled()
})

test('a merge also waits for an Auto run that owns its destination', async () => {
  const { gitWorktrees } = await import('./ipc')
  vi.mocked(gitWorktrees).mockResolvedValueOnce([
    { path: '/p/w', branch: 'feature', head: 'f', main: false, current: false },
    { path: '/p', branch: 'main', head: 'm', main: true, current: true },
  ])
  useStore.setState({ auto: { status: 'running' } as AutoRun, activeTask: null })
  await expect(
    launchMerge('manual', 't', {
      project,
      source: { path: '/p/w', branch: 'feature', head: 'f', main: false, current: false },
      destinationBranch: 'main',
      device: {} as never,
    }),
  ).rejects.toThrow('Auto is running')
  expect(startMerge).not.toHaveBeenCalled()
})

test('a paused Auto run hands the worktree back, as its pause messages ask', async () => {
  useStore.setState({ auto: { status: 'paused' } as AutoRun, activeTask: null })
  await launchReview('manual', project, null, request, [])
  expect(startSimpleReview).toHaveBeenCalledOnce()
})

test('Open Auto selects the merge destination, even when the source is the active worktree', async () => {
  const { gitWorktrees } = await import('./ipc')
  const { openWorktreeAuto, returnAfterAutoStop } = await import('./workBlocker')
  const source = { path: '/p', branch: 'main', head: 'm', main: true, current: true }
  const destination = { path: '/p/w', branch: 'feature', head: 'f', main: false, current: false }
  vi.mocked(gitWorktrees).mockResolvedValue([source, destination])
  const run = { runId: 'destination-run', status: 'running' } as AutoRun
  useStore.getState().patchTask('p', 't', { auto: run })
  const routed = launchMerge('manual', null, {
    project,
    source,
    destinationBranch: 'feature',
    device: {} as never,
  })
  await expect(routed).rejects.toMatchObject({
    recovery: { kind: 'auto', target: { projectId: 'p', task: 't' } },
  })
  await routed.catch((error) =>
    openWorktreeAuto(error.recovery.target, error.recovery.returnAfterStop),
  )
  expect(useStore.getState()).toMatchObject({ activeTask: 't', utilityPanel: 'auto' })
  returnAfterAutoStop({ projectId: 'p', task: 't' }, run)
  expect(useStore.getState()).toMatchObject({ activeTask: null, utilityPanel: null })
  expect(startMerge).not.toHaveBeenCalled()
})

test('merge rechecks the resolved destination when Auto takes it during preflight', async () => {
  const { gitWorktrees } = await import('./ipc')
  const source = { path: '/p', branch: 'main', head: 'm', main: true, current: true }
  vi.mocked(gitWorktrees).mockResolvedValue([source])
  vi.mocked(startMerge).mockImplementationOnce(async (options) => {
    useStore.getState().patchTask('p', 't', { auto: { status: 'waitingOnYou' } as AutoRun })
    if ('source' in options) {
      options.beforeLaunch?.({
        source: '/p',
        sourceBranch: 'main',
        destination: '/p/w',
        destinationBranch: 'feature',
      })
    }
    throw new Error('Merge escaped its ownership check')
  })
  await expect(
    launchMerge('chat', null, {
      project,
      source,
      destinationBranch: 'feature',
      device: {} as never,
    }),
  ).rejects.toMatchObject({
    recovery: { kind: 'auto', target: { projectId: 'p', task: 't' } },
  })
})
