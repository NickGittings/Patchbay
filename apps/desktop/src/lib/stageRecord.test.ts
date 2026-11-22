import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('./simpleActions', () => ({ logLaunch: vi.fn(async () => {}) }))
vi.mock('./stageRetire', () => ({ retireStageAgents: vi.fn(async () => {}) }))
vi.mock('./chatTeams', () => ({ noteLead: vi.fn(async () => {}), teamFor: vi.fn(() => team) }))
const team = vi.hoisted(() => ({ id: 'team' }))
import { useStore } from '../store'
import { noteLead } from './chatTeams'
import { logLaunch } from './simpleActions'
import { recordStageLaunch, type StageAction } from './stageRecord'
import { retireStageAgents } from './stageRetire'
import type { SimpleOrigin } from './simple'

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({ reviewAgents: {} })
})
const record = (origin: SimpleOrigin, action: StageAction) =>
  recordStageLaunch({
    projectId: 'p',
    task: 't',
    origin,
    action,
    launched: [{ sessionId: 'agent', requestId: 'request' }],
  })

test('every origin logs its launch in the worktree chat, tagged with where it came from', async () => {
  for (const origin of ['chat', 'manual', 'lead', 'auto'] as const) {
    await record(origin, 'implement')
    expect(logLaunch).toHaveBeenLastCalledWith(
      'p',
      't',
      { kind: 'action', action: 'implement', stage: 'build', sessionId: 'agent', origin },
      'request',
      { atRunStart: true },
    )
  }
})

test('a merge keeps its request and stays dated at its click', async () => {
  const request = { source: '/w', sourceBranch: 'b', destination: '/p', destinationBranch: 'main' }
  await recordStageLaunch({
    projectId: 'p',
    task: 't',
    origin: 'auto',
    action: 'merge',
    launched: [{ sessionId: 'merger', requestId: 'request' }],
    request,
    autoRunId: 'run',
  })
  expect(logLaunch).toHaveBeenCalledWith(
    'p',
    't',
    expect.objectContaining({ action: 'merge', stage: 'merge', request, autoRunId: 'run' }),
    'request',
    undefined,
  )
})

test('Chat and the regular views retire the stage before and tell the lead', async () => {
  for (const origin of ['chat', 'manual'] as const) {
    vi.clearAllMocks()
    await record(origin, 'review')
    expect(retireStageAgents).toHaveBeenCalledWith('p', 't', ['agent'], undefined)
    expect(noteLead).toHaveBeenCalledWith(
      team,
      'a review of this worktree',
      ['agent'],
      'request',
      origin === 'chat' ? 'with Chat’s workflow buttons' : 'from the Plan or Review view',
    )
  }
  vi.clearAllMocks()
  // A build replaces nothing: the planner may still be needed.
  await record('manual', 'implement')
  expect(retireStageAgents).not.toHaveBeenCalled()
  expect(noteLead).toHaveBeenCalledOnce()
})

test('the lead and Auto keep their agents and are not told about their own launches', async () => {
  for (const origin of ['lead', 'auto'] as const) {
    await record(origin, 'fix')
    expect(retireStageAgents).not.toHaveBeenCalled()
    expect(noteLead).not.toHaveBeenCalled()
  }
})

test('review and merge agents become the Review view’s current agent without opening it', async () => {
  await record('auto', 'review')
  expect(useStore.getState().reviewAgents.p).toEqual({ sid: 'agent', hidden: true })
  useStore.setState({ reviewAgents: { p: { sid: 'old', hidden: false } } })
  await record('chat', 'merge')
  expect(useStore.getState().reviewAgents.p).toEqual({ sid: 'agent', hidden: false })
  await record('chat', 'fix')
  expect(useStore.getState().reviewAgents.p.sid).toBe('agent')
})

test('nothing launched records nothing', async () => {
  await recordStageLaunch({
    projectId: 'p',
    task: 't',
    origin: 'chat',
    action: 'review',
    launched: [],
  })
  expect(logLaunch).not.toHaveBeenCalled()
  expect(noteLead).not.toHaveBeenCalled()
})
