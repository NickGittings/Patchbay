import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('./simpleReview', () => ({
  startSimpleReview: vi.fn(async () => ({
    started: [{ sessionId: 'reviewer', requestId: 'request', lane: null }],
    errors: [],
    round: 'round',
  })),
}))
vi.mock('./reviewAgents', () => ({ startMerge: vi.fn() }))
vi.mock('./stageRecord', () => ({ recordStageLaunch: vi.fn(async () => {}) }))
vi.mock('./planHandoff', () => ({ implementPlannerPlan: vi.fn() }))
vi.mock('./reviewHandoff', () => ({ fixReviewFindings: vi.fn() }))
import { useStore } from '../store'
import type { AutoRun, Project, Task } from '../types'
import { launchMerge, launchReview, taskOfWorktree } from './launchStage'
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
  expect(taskOfWorktree('/p')).toBeNull()
  expect(taskOfWorktree('/p/w')).toBe('t')
  expect(taskOfWorktree('/elsewhere')).toBeUndefined()
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
