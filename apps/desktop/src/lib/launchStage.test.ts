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

test.each(['running', 'waitingOnYou', 'paused'] as const)(
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
  useStore.setState({ auto: { status: 'paused' } as AutoRun, activeTask: null })
  const reviewer = { metadata: { projectId: 'p' }, spec: { cwd: '/p' } } as never
  await expect(launchFix('manual', reviewer, 'follow')).rejects.toThrow('Auto is paused')
  expect(fixReviewFindings).not.toHaveBeenCalled()
  await expect(
    launchMerge('manual', null, {
      project,
      source: { path: '/p', branch: 'x', head: 'h', main: true, current: true },
      destinationBranch: 'main',
      device: {} as never,
    }),
  ).rejects.toThrow('Stop Auto or let it finish first')
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
