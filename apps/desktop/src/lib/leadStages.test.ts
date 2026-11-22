import { beforeEach, expect, test, vi } from 'vitest'
const mergeRequest = vi.hoisted(() => ({
  source: '/p',
  sourceBranch: 'feature',
  destination: '/main',
  destinationBranch: 'main',
}))
vi.mock('./ipc', () => ({
  terminalSnapshot: vi.fn(async () => ({ running: true })),
  planRead: vi.fn(async () => ({ text: '', savedMs: null, cut: false })),
  gitWorktrees: vi.fn(async () => [{ path: '/p', branch: 'feature' }]),
  gitBranches: vi.fn(async () => ['feature', 'main']),
  mergeSourceChanges: vi.fn(async () => []),
  mergeOutcome: vi.fn(async () => 'merged'),
}))
vi.mock('./sessions', () => ({ startTerminal: vi.fn(async () => 'launch') }))
vi.mock('./simpleActions', () => ({ logLaunch: vi.fn(async () => {}) }))
vi.mock('./chatTeams', () => ({ controlTeam: vi.fn(async () => {}) }))
vi.mock('./agentRoles', () => ({ roleDevice: vi.fn(() => ({ id: 'planner' })) }))
vi.mock('./planHandoff', () => ({
  implementPlannerPlan: vi.fn(async () => ({ sessionId: 'build', requestId: 'launch' })),
}))
vi.mock('./reviewHandoff', () => ({
  fixReviewFindings: vi.fn(async () => ({ sessionId: 'fix', requestId: 'launch' })),
}))
vi.mock('./reviewAgents', () => ({
  reviewAgentRecords: vi.fn(() => [
    { id: 'reviewer', metadata: { componentId: '__review__' }, spec: { cwd: '/p' } },
  ]),
  reviewWorktreeBusy: vi.fn(() => false),
  defaultMergeDestination: vi.fn(() => 'main'),
  // Reports the source's uncommitted changes the way the real preflight does.
  startMerge: vi.fn(async (options: { commitSource?: unknown }) => {
    const { mergeSourceChanges } = await import('./ipc')
    const changes = await mergeSourceChanges({} as never, '', '')
    return options.commitSource === 'report' && changes.length
      ? { kind: 'uncommitted', changes }
      : { kind: 'started', request: mergeRequest, sessionId: 'merge', requestId: 'merge-launch' }
  }),
}))
vi.mock('./sessionList', () => ({ sessionTimeMs: vi.fn(() => 0) }))
vi.mock('./stageLog', () => ({ logStageLaunch: vi.fn(async () => {}) }))
vi.mock('../types', () => ({
  PLAN_SCOPE: '__plan__',
  REVIEW_SCOPE: '__review__',
  plannerChatTask: vi.fn(),
  plannerSessionId: vi.fn(() => 'plan'),
}))
vi.mock('../store', () => ({
  useStore: { getState: vi.fn() },
  projectOf: vi.fn(() => ({ projectId: 'p' })),
  projectStateOf: vi.fn(() => ({ stories: [] })),
}))
vi.mock('./stories', () => ({
  findStory: vi.fn(async (_project: string, id: string) => ({ id, components: ['api'] })),
  storyComponents: vi.fn(() => ['api']),
  launchStoryPlanner: vi.fn(async () => 'story-launch'),
}))
import { useStore } from '../store'
import { controlTeam, type ChatTeam } from './chatTeams'
import { mergeOutcome, mergeSourceChanges, planRead, terminalSnapshot } from './ipc'
import { settleLeadStage, startLeadStage } from './leadStages'
import { implementPlannerPlan } from './planHandoff'
import { fixReviewFindings } from './reviewHandoff'
import { reviewWorktreeBusy, startMerge } from './reviewAgents'
import { startTerminal } from './sessions'
import { logLaunch } from './simpleActions'
import { launchStoryPlanner } from './stories'

const team = { id: 'team', projectId: 'p', task: 't1', target: '/p' } as ChatTeam
const request = (
  action: string,
  state = 'starting',
  result: string | null = null,
  settings: Record<string, unknown> = {},
) =>
  ({ id: 'request', action, settings, state, result }) as NonNullable<ChatTeam['requests']>[number]
const running = request('startBuild', 'running', '{"sessionId":"build","startedMs":100}')
const withSessions = (sessions: unknown) =>
  vi.mocked(useStore.getState).mockReturnValue({
    sessionRecords: [],
    sessions,
    devices: [],
    agentRoles: {},
  } as unknown as ReturnType<typeof useStore.getState>)
const lastControl = () => vi.mocked(controlTeam).mock.lastCall?.[1]

beforeEach(() => {
  vi.clearAllMocks()
  withSessions({})
})

test('a build launches for the owning team and stays active on its agent', async () => {
  await startLeadStage(team, request('startBuild'))
  expect(vi.mocked(implementPlannerPlan).mock.calls[0][4]).toEqual({
    projectId: 'p',
    task: 't1',
    chatTeam: 'team',
  })
  expect(controlTeam).toHaveBeenCalledWith(
    team,
    expect.objectContaining({ kind: 'note', sessions: ['build'] }),
  )
  expect(lastControl()).toMatchObject({ kind: 'requestState', state: 'running' })
})

const ended = (id: string) =>
  withSessions({ [id]: { running: true, status: { agent: { state: 'review', sinceMs: 200 } } } })
const planning = request('startPlan', 'starting', null, { goal: 'Plan the importer' })
const planRun = request('startPlan', 'running', '{"sessionId":"plan","startedMs":100}')
const mergeRun = request(
  'startMerge',
  'running',
  JSON.stringify({ sessionId: 'merge', startedMs: 100, merge: mergeRequest }),
)

test('a plan starts the plan role with the request in its briefing', async () => {
  await startLeadStage(team, planning)
  expect(startTerminal).toHaveBeenCalledWith(
    '__plan__',
    'planner',
    't1',
    'p',
    expect.objectContaining({ kickoff: { kind: 'planRequest' }, planRequest: 'Plan the importer' }),
  )
  expect(lastControl()).toMatchObject({ kind: 'requestState', state: 'running' })
})

test('a plan for a story gives its planner the story briefing in the team worktree', async () => {
  await startLeadStage(team, request('startPlan', 'starting', null, { story: 's1' }))
  expect(launchStoryPlanner).toHaveBeenCalledExactlyOnceWith(
    'p',
    't1',
    'planner',
    { id: 's1', components: ['api'] },
    ['api'],
    undefined,
  )
  expect(startTerminal).not.toHaveBeenCalled()
  expect(lastControl()).toMatchObject({ kind: 'requestState', state: 'running' })
})

test("a story plan keeps the user's goal and treats no components as the story's", async () => {
  await startLeadStage(
    team,
    request('startPlan', 'starting', null, { story: 's1', goal: 'Skip CSV', components: [] }),
  )
  expect(launchStoryPlanner).toHaveBeenCalledExactlyOnceWith(
    'p',
    't1',
    'planner',
    { id: 's1', components: ['api'] },
    ['api'],
    'Skip CSV',
  )
})

test('a plan never replaces a planner that is already running', async () => {
  withSessions({ plan: { running: true } })
  await expect(startLeadStage(team, planning)).rejects.toThrow('already running')
  expect(startTerminal).not.toHaveBeenCalled()
})

test('a finished planner reports whether it saved a plan', async () => {
  ended('plan')
  await settleLeadStage(team, planRun)
  expect(lastControl()).toMatchObject({ state: 'failed' })
  vi.mocked(planRead).mockResolvedValueOnce({ text: 'Plan', savedMs: 150, cut: false })
  await settleLeadStage(team, planRun)
  expect(lastControl()).toMatchObject({ state: 'completed' })
})

test('a merge goes to the default destination through the merge role', async () => {
  await startLeadStage(team, request('startMerge'))
  expect(startMerge).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ destinationBranch: 'main', commitSource: 'report' }),
  )
  expect(lastControl()).toMatchObject({ kind: 'requestState', state: 'running' })
})

test('a merge commits uncommitted changes only when they were approved', async () => {
  vi.mocked(mergeSourceChanges).mockResolvedValue([' M a.ts'])
  await expect(startLeadStage(team, request('startMerge'))).rejects.toThrow(' M a.ts')
  expect(logLaunch).not.toHaveBeenCalled()
  await startLeadStage(
    team,
    request('startMerge', 'starting', null, { destination: 'dev', commitSource: [' M a.ts'] }),
  )
  expect(startMerge).toHaveBeenLastCalledWith(
    expect.objectContaining({ destinationBranch: 'dev', commitSource: [' M a.ts'] }),
  )
  vi.mocked(mergeSourceChanges).mockResolvedValue([])
})

test('a confirmed merge stays quiet and any other outcome wakes the lead', async () => {
  ended('merge')
  await settleLeadStage(team, mergeRun)
  expect(lastControl()).toMatchObject({ state: 'completed', passive: true })
  vi.mocked(mergeOutcome).mockResolvedValueOnce('notMerged')
  await settleLeadStage(team, mergeRun)
  expect(lastControl()).toMatchObject({ state: 'failed' })
  expect(lastControl()).not.toHaveProperty('passive')
})

test('a fix waits for a review that may still be writing', async () => {
  vi.mocked(reviewWorktreeBusy).mockReturnValueOnce(true)
  await expect(startLeadStage(team, request('startFix'))).rejects.toThrow('current review')
  expect(fixReviewFindings).not.toHaveBeenCalled()
})

test('a stage stays active while its agent works', async () => {
  withSessions({ build: { running: true, status: { agent: { state: 'working', sinceMs: 200 } } } })
  await settleLeadStage(team, running)
  expect(controlTeam).not.toHaveBeenCalled()
})

test('a turn from before the launch does not settle a stage', async () => {
  withSessions({
    build: {
      running: true,
      status: { agent: { state: 'review', sinceMs: 50, authoritative: true } },
    },
  })
  await settleLeadStage(team, running)
  expect(controlTeam).not.toHaveBeenCalled()
})

test('a stage completes when its agent ends a turn', async () => {
  withSessions({
    build: {
      running: true,
      status: { agent: { state: 'review', sinceMs: 200, authoritative: true } },
    },
  })
  await settleLeadStage(team, running)
  expect(lastControl()).toMatchObject({ state: 'completed' })
})

test('an agent that exited before any check still reports to the lead', async () => {
  withSessions({ build: { running: false } })
  await settleLeadStage(team, running)
  expect(lastControl()).toMatchObject({
    state: 'completed',
    result: expect.stringContaining('exited'),
  })
})

test('a stage whose session no longer exists fails', async () => {
  vi.mocked(terminalSnapshot).mockResolvedValueOnce(null)
  await settleLeadStage(team, running)
  expect(lastControl()).toMatchObject({ state: 'failed' })
})
