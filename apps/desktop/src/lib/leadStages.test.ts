import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('./ipc', () => ({ terminalSnapshot: vi.fn(async () => ({ running: true })) }))
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
}))
vi.mock('./sessionList', () => ({ sessionTimeMs: vi.fn(() => 0) }))
vi.mock('./stageLog', () => ({ logStageLaunch: vi.fn(async () => {}) }))
vi.mock('../types', () => ({
  PLAN_SCOPE: '__plan__',
  REVIEW_SCOPE: '__review__',
  plannerChatTask: vi.fn(),
}))
vi.mock('../store', () => ({ useStore: { getState: vi.fn() } }))
import { useStore } from '../store'
import { controlTeam, type ChatTeam } from './chatTeams'
import { terminalSnapshot } from './ipc'
import { settleLeadStage, startLeadStage } from './leadStages'
import { implementPlannerPlan } from './planHandoff'
import { fixReviewFindings } from './reviewHandoff'
import { reviewWorktreeBusy } from './reviewAgents'

const team = { id: 'team', projectId: 'p', task: 't1', target: '/p' } as ChatTeam
const request = (action: string, state = 'starting', result: string | null = null) =>
  ({ id: 'request', action, settings: {}, state, result }) as NonNullable<
    ChatTeam['requests']
  >[number]
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
