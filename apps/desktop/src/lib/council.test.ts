import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('./ipc', () => ({
  gitWorktrees: vi.fn(async () => [{ path: '/p', branch: 'feature' }]),
  reviewRead: vi.fn(async () => null),
  reviewAgentStart: vi.fn(async () => 'review-session'),
  terminalStop: vi.fn(async () => {}),
}))
vi.mock('./simpleReview', () => ({ retireReviewSlots: vi.fn(async () => {}) }))
vi.mock('./reviewAgents', () => ({ reviewWorktreeBusy: vi.fn(() => false) }))
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
import { reviewAgentStart, reviewRead } from './ipc'
import { useStore } from '../store'
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
