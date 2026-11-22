import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('./ipc', () => ({
  gitWorktrees: vi.fn(async () => [{ path: '/p', branch: 'feature' }]),
  gitBranches: vi.fn(async () => ['main', 'feature']),
  reviewRead: vi.fn(async () => null),
  reviewAgentStart: vi.fn(async () => 'review-session'),
  terminalSnapshot: vi.fn(async () => ({ running: true })),
  terminalStop: vi.fn(async () => {}),
}))
vi.mock('./providerAuth', () => ({ requireProviderAuth: vi.fn(async () => {}) }))
vi.mock('./simpleReview', () => ({ retireReviewSlots: vi.fn(async () => {}) }))
vi.mock('./reviewAgents', () => ({
  reviewWorktreeBusy: vi.fn(() => false),
  chatReviewBase: vi.fn(() => 'main'),
}))
vi.mock('./agentRoles', () => ({ roleDevices: vi.fn(() => []) }))
vi.mock('./stageRecord', () => ({ recordStageLaunch: vi.fn(async () => {}) }))
vi.mock('./sessions', () => ({
  listenForTerminals: vi.fn(async () => {}),
  reconcileFreshSessions: vi.fn(async () => {}),
}))
vi.mock('./chatTeams', () => ({
  controlTeam: vi.fn(async () => {}),
  requireTeamPreset: vi.fn(async () => {}),
  useChatTeams: { getState: () => ({ teams: {} }) },
}))
vi.mock('../store', () => ({
  projectOf: vi.fn(() => ({ root: '/p', projectId: 'p' })),
  projectStateOf: vi.fn(() => ({ tasks: [] })),
  useStore: { getState: vi.fn(() => ({ sessionRecords: [], sessions: {} })) },
}))
import {
  cancelCouncil,
  councilSettings,
  driveCouncil,
  savedCouncil,
  type CouncilRun,
} from './council'
import { controlTeam, requireTeamPreset, type ChatTeam } from './chatTeams'
import { gitBranches, gitWorktrees, reviewAgentStart, reviewRead, terminalSnapshot } from './ipc'
import { requireProviderAuth } from './providerAuth'
import { chatReviewBase } from './reviewAgents'
import { reconcileFreshSessions } from './sessions'
import { useStore } from '../store'
import { roleDevices } from './agentRoles'
import { retireReviewSlots } from './simpleReview'
import { recordStageLaunch } from './stageRecord'
import type { ReviewFindings } from '../types'
const presets = ['codex', 'claude'].map((id) => ({
  id,
  name: id,
  command: id,
  kind: 'agent' as const,
}))
const team = { id: 'team', projectId: 'p', target: '/p', state: 'running' } as ChatTeam
function request() {
  return {
    id: crypto.randomUUID(),
    action: 'startCouncilReview',
    settings: { base: 'main' },
    state: 'starting',
    result: null,
    council: [{ enabled: true, members: ['codex', 'claude'], concurrency: 1 }, presets],
  } as NonNullable<ChatTeam['requests']>[number]
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(reviewRead).mockResolvedValue(null)
  vi.mocked(controlTeam).mockResolvedValue(team)
  vi.mocked(useStore.getState).mockReturnValue({
    sessionRecords: [],
    sessions: {},
  } as unknown as ReturnType<typeof useStore.getState>)
})
test('settings restore disabled with independent reviewer defaults and bounded concurrency', () => {
  expect(councilSettings(undefined, ['a', 'b'])).toEqual({
    enabled: false,
    members: ['a', 'b'],
    concurrency: 2,
  })
  expect(councilSettings({ enabled: true, members: ['a', 'a', 9], concurrency: 99 })).toEqual({
    enabled: true,
    members: ['a'],
    concurrency: 2,
  })
})
test('mixed-provider reviewers launch within capacity after durable launch intent', async () => {
  const r = request()
  r.settings.focus = 'Security and authentication'
  const saved: string[] = []
  vi.mocked(controlTeam).mockImplementation(async (_, control) => {
    if (control.kind === 'requestState' && control.result) saved.push(control.result)
    return team
  })
  await driveCouncil(team, r)
  expect(reviewAgentStart).toHaveBeenCalledTimes(1)
  expect(reviewAgentStart).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      base: 'main',
      branch: 'feature',
      lane: 'codex',
      focus: 'Security and authentication',
    }),
    presets[0],
    expect.any(String),
  )
  expect(saved.some((s) => JSON.parse(s).members[0].state === 'launching')).toBe(true)
  expect(JSON.parse(saved.at(-1)!).members[1].state).toBe('queued')
})
test('restored pending members fail without launching duplicate reviews', async () => {
  const r = request()
  r.state = 'running'
  r.councilRun = {
    round: 'old-round',
    branch: 'feature',
    base: 'main',
    members: presets.map((preset) => ({ preset, requestId: preset.id, state: 'queued' })),
  }
  await driveCouncil(team, r)
  expect(reviewAgentStart).not.toHaveBeenCalled()
  expect(controlTeam).toHaveBeenLastCalledWith(
    team,
    expect.objectContaining({ state: 'failed', result: expect.stringContaining('INCOMPLETE') }),
  )
})
test('durable council state survives final result text', () => {
  const r = request()
  r.councilRun = { round: 'saved', members: [] } as unknown as CouncilRun
  r.result = 'Final review'
  expect(savedCouncil(r)?.round).toBe('saved')
})

test('cancellation saves failed member outcomes before finalizing so reports can be archived', async () => {
  const r = request()
  r.state = 'running'
  r.councilRun = {
    round: 'cancel-round',
    branch: 'feature',
    base: 'main',
    members: [{ preset: presets[0], requestId: 'member', sessionId: 'review', state: 'running' }],
  }
  await cancelCouncil(team, r)
  const updates = vi.mocked(controlTeam).mock.calls.map(([, control]) => control)
  expect(updates[0]).toMatchObject({ kind: 'requestState', state: 'running' })
  if (updates[0].kind === 'requestState')
    expect(JSON.parse(updates[0].result!).members[0].state).toBe('failed')
  expect(updates[1]).toMatchObject({ kind: 'requestState', state: 'failed' })
})
test('provider setup failures never launch an untrackable reviewer', async () => {
  vi.mocked(requireTeamPreset).mockRejectedValueOnce(new Error('Set up Agent status integration'))
  await driveCouncil(team, request())
  expect(reviewAgentStart).not.toHaveBeenCalled()
  expect(controlTeam).toHaveBeenLastCalledWith(
    team,
    expect.objectContaining({ result: expect.stringContaining('Set up Agent status integration') }),
  )
})

function leadReview(state = 'starting') {
  return {
    id: 'lead-review',
    action: 'startReview',
    settings: {},
    state,
    result: null,
  } as NonNullable<ChatTeam['requests']>[number]
}
const devices = (...ids: string[]) =>
  ids.map((id) => ({ id, name: id, command: id })) as ReturnType<typeof roleDevices>
test('a lead review launches the regular reviewer and appears as its stage', async () => {
  vi.mocked(roleDevices).mockReturnValue(devices('codex'))
  await driveCouncil({ ...team, task: 't1' } as ChatTeam, leadReview())
  const request = vi.mocked(reviewAgentStart).mock.calls[0][1]
  expect(request).toMatchObject({ worktree: '/p', branch: 'feature', base: 'main' })
  expect(request.lane).toBeUndefined()
  expect(retireReviewSlots).toHaveBeenCalledWith('p', '/p', [null])
  expect(recordStageLaunch).toHaveBeenCalledWith({
    projectId: 'p',
    task: 't1',
    action: 'review',
    // The lead started it, so the lead decides what follows.
    origin: 'lead',
    launched: [expect.objectContaining({ sessionId: 'review-session' })],
  })
  expect(controlTeam).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ kind: 'note', sessions: ['review-session'] }),
  )
})
test('every configured reviewer of a lead review starts in its own lane', async () => {
  vi.mocked(roleDevices).mockReturnValue(devices('codex', 'claude'))
  await driveCouncil(team, leadReview())
  expect(vi.mocked(reviewAgentStart).mock.calls.map(([, r]) => r.lane)).toEqual(['codex', 'claude'])
})
const runningReview = (startedMs = 100) => {
  const r = leadReview('running')
  r.councilRun = {
    round: 'round',
    branch: 'feature',
    base: 'main',
    members: [
      { preset: presets[0], requestId: 'one', sessionId: 'review', startedMs, state: 'running' },
    ],
  }
  return r
}
const withSessions = (sessions: unknown) =>
  vi.mocked(useStore.getState).mockReturnValue({
    sessionRecords: [],
    sessions,
  } as unknown as ReturnType<typeof useStore.getState>)
const lastResult = () => {
  const control = vi.mocked(controlTeam).mock.lastCall![1]
  return control.kind === 'requestState' ? control : undefined
}
const stopped = (sinceMs: number) => ({
  review: {
    running: true,
    status: { agent: { state: 'review', sinceMs, authoritative: true } },
  },
})
test('a reviewer that ends its turn without findings fails the review', async () => {
  withSessions(stopped(200))
  await driveCouncil(team, runningReview())
  expect(lastResult()).toMatchObject({ state: 'failed' })
  expect(lastResult()?.result).toContain('stopped without complete findings')
})
test('a turn that ended before this launch does not settle its reviewer', async () => {
  withSessions(stopped(50))
  await driveCouncil(team, runningReview())
  expect(lastResult()).toMatchObject({ state: 'running' })
})
test('a reviewer whose session no longer exists fails the review', async () => {
  vi.mocked(terminalSnapshot).mockResolvedValueOnce(null)
  await driveCouncil(team, runningReview())
  expect(lastResult()).toMatchObject({ state: 'failed' })
  expect(lastResult()?.result).toContain('no longer exists')
})
test('a failed refresh after launch leaves the reviewer running and recorded', async () => {
  vi.mocked(roleDevices).mockReturnValue(devices('codex'))
  vi.mocked(reconcileFreshSessions).mockRejectedValueOnce(new Error('refresh failed'))
  await driveCouncil(team, leadReview())
  expect(JSON.parse(lastResult()!.result!).members[0]).toMatchObject({
    state: 'running',
    sessionId: 'review-session',
  })
  expect(recordStageLaunch).toHaveBeenCalledOnce()
})
test('a lead review needs provider sign-in but not status hooks', async () => {
  vi.mocked(roleDevices).mockReturnValue(devices('codex'))
  await driveCouncil(team, leadReview())
  expect(requireProviderAuth).toHaveBeenCalledOnce()
  expect(requireTeamPreset).not.toHaveBeenCalled()
  expect(reviewAgentStart).toHaveBeenCalledOnce()
})
test('an explicit lead review base skips the saved base lookup', async () => {
  vi.mocked(roleDevices).mockReturnValue(devices('codex'))
  const r = leadReview()
  r.settings.base = 'main'
  await driveCouncil(team, r)
  expect(gitWorktrees).toHaveBeenCalledOnce()
  expect(gitBranches).toHaveBeenCalledOnce()
  expect(chatReviewBase).not.toHaveBeenCalled()
})
test('a finished lead review reports its findings to the lead', async () => {
  const r = leadReview('running')
  r.councilRun = {
    round: 'round',
    branch: 'feature',
    base: 'main',
    members: [{ preset: presets[0], requestId: 'one', sessionId: 'review', state: 'running' }],
  }
  vi.mocked(reviewRead).mockResolvedValue({
    round: 'round',
    text: 'One bug in app.ts',
    verdict: { clean: false, counts: {} },
    reviewers: [{ lane: null, finished: true, verdict: { clean: false, counts: {} } }],
  } as unknown as ReviewFindings)
  vi.mocked(useStore.getState).mockReturnValue({
    sessionRecords: [],
    sessions: { review: { running: false } },
  } as unknown as ReturnType<typeof useStore.getState>)
  await driveCouncil(team, r)
  expect(controlTeam).toHaveBeenLastCalledWith(
    team,
    expect.objectContaining({
      kind: 'requestState',
      result: expect.stringContaining('One bug in app.ts'),
    }),
  )
  expect(savedCouncil(r)?.members[0].state).toBe('running')
})
