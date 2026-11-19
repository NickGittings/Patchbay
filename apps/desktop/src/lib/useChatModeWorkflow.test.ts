import { beforeEach, describe, expect, test, vi } from 'vitest'
const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const i = hooks.cursor++
    if (!(i in hooks.states)) hooks.states[i] = initial
    return [
      hooks.states[i],
      (value: unknown) => {
        hooks.states[i] = typeof value === 'function' ? value(hooks.states[i]) : value
      },
    ]
  },
}))
vi.mock('./reviewHandoff', () => ({ fixReviewFindings: vi.fn() }))
vi.mock('./reviewAgents', () => ({ startMergeAgent: vi.fn() }))
vi.mock('./chatTeams', () => ({ controlTeam: vi.fn(), noteLead: vi.fn(), resetLead: vi.fn() }))
vi.mock('./auto', () => ({
  mergeNow: vi.fn(),
  resumeAuto: vi.fn(),
  pauseAuto: vi.fn(),
  stopAuto: vi.fn(),
}))
vi.mock('./planHandoff', () => ({ implementPlannerPlan: vi.fn() }))
vi.mock('./stageRetire', () => ({ retireStageAgents: vi.fn() }))
vi.mock('./simpleActions', () => ({
  clearSimpleChat: vi.fn(),
  logLaunch: vi.fn(),
  logSimple: vi.fn(),
}))
vi.mock('./ipc', () => ({
  gitBranches: vi.fn(),
  gitWorktrees: vi.fn(),
  mergeConflicts: vi.fn(),
  mergeSourceChanges: vi.fn(),
}))
vi.mock('./simpleReview', () => ({
  simpleReviewRequest: vi.fn(() => ({})),
  startSimpleReview: vi.fn(),
}))
import { useStore } from '../store'
import { simpleKey, useSimpleUi } from './simpleUi'
import { useChatModeWorkflow } from './useChatModeWorkflow'
import { implementPlannerPlan } from './planHandoff'
import { noteLead } from './chatTeams'
import { clearSimpleChat, logLaunch } from './simpleActions'
import { gitBranches, gitWorktrees, mergeConflicts, mergeSourceChanges } from './ipc'
import { startMergeAgent } from './reviewAgents'
import { startSimpleReview } from './simpleReview'
import { thread } from './simple'
import { retireStageAgents } from './stageRetire'
type Context = Parameters<typeof useChatModeWorkflow>[0]
let context: Context
function render(overrides: Partial<Context> = {}) {
  hooks.cursor = 0
  return Workflow({ ...context, ...overrides })
}
function Workflow(props: Context) {
  return useChatModeWorkflow(props)
}
const idle = async () => {
  await vi.waitFor(() =>
    expect(useSimpleUi.getState().worktrees[context.key]?.pendingWorkflow).toBe(false),
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  hooks.states = []
  useStore.setState(useStore.getInitialState())
  useSimpleUi.setState({ worktrees: {} })
  useStore.setState({ project: { id: 'p', name: 'P', root: '/p' } })
  const s = useStore.getState()
  context = {
    key: simpleKey('p', null),
    projectId: 'p',
    task: null,
    model: thread(
      { records: [], sessions: {}, simple: null, auto: null },
      { projectId: 'p', task: null, path: '/p' },
    ),
    source: undefined,
    target: undefined,
    reviewBase: 'main',
    devices: s.devices,
    agentRoles: s.agentRoles,
    auto: null,
    simple: null,
    changed: [],
    team: undefined,
    focusComposer: vi.fn(),
  }
})
test('duplicate launches share a scope lock and release it after failure', async () => {
  let reject!: (error: Error) => void
  vi.mocked(implementPlannerPlan).mockReturnValue(
    new Promise((_, fail) => {
      reject = fail
    }),
  )
  render().act('build')
  render().act('build')
  expect(implementPlannerPlan).toHaveBeenCalledTimes(1)
  expect(render().pending).toBe('build')
  reject(new Error('launch failed'))
  await idle()
  expect(render().failure).toContain('launch failed')
  vi.mocked(implementPlannerPlan).mockResolvedValue({ sessionId: 'builder' })
  render().act('build')
  await idle()
  expect(implementPlannerPlan).toHaveBeenCalledTimes(2)
  expect(render().failure).toBe('')
  // The lead hears of work started beside it, with the session whose finish must not wake it.
  expect(vi.mocked(noteLead).mock.calls.at(-1)?.slice(1, 3)).toEqual([
    'a build of the saved plan',
    ['builder'],
  ])
})
test('late failure stays scoped to its original chat', async () => {
  let reject!: (error: Error) => void
  vi.mocked(implementPlannerPlan).mockReturnValue(
    new Promise((_, fail) => {
      reject = fail
    }),
  )
  render().act('build')
  useStore.setState({ activeTask: 'other' })
  const other = { key: simpleKey('p', 'other'), task: 'other' }
  expect(render(other).pending).toBe('')
  reject(new Error('old launch failed'))
  await idle()
  expect(render(other).failure).toBe('')
  expect(render().failure).toContain('old launch failed')
})
test('stale build and review actions do not launch in another worktree', async () => {
  const old = render()
  useStore.setState({ activeTask: 'other' })
  old.act('build')
  await idle()
  expect(implementPlannerPlan).not.toHaveBeenCalled()
  expect(render().failure).toContain('worktree changed')
  vi.mocked(gitBranches).mockResolvedValue(['main'])
  old.act('review')
  await idle()
  expect(startSimpleReview).not.toHaveBeenCalled()
  expect(render().failure).toContain('Choose Review')
})
test('partial review success logs started reviewers and surfaces remaining errors', async () => {
  vi.mocked(gitBranches).mockResolvedValue(['main'])
  vi.mocked(startSimpleReview).mockResolvedValue({
    started: [{ sessionId: 'reviewer', requestId: 'request', lane: null }],
    errors: ['second reviewer failed'],
    round: 'round',
  })
  render().act('review')
  await idle()
  expect(logLaunch).toHaveBeenCalledWith(
    'p',
    null,
    expect.objectContaining({ action: 'review', sessionId: 'reviewer' }),
    'request',
    { atRunStart: true },
  )
  expect(render().failure).toBe('second reviewer failed')
  expect(retireStageAgents).toHaveBeenCalledWith('p', null, ['reviewer'], context.model.foreign)
})
test('a stage that fails to launch leaves the earlier agents running', async () => {
  vi.mocked(gitBranches).mockResolvedValue(['main'])
  vi.mocked(startSimpleReview).mockResolvedValue({
    started: [],
    errors: ['no reviewer started'],
    round: 'round',
  })
  render().act('review')
  await idle()
  expect(render().failure).toBe('no reviewer started')
  expect(retireStageAgents).not.toHaveBeenCalled()
})
test('history confirmation rejects stale scopes and pending input', async () => {
  const workflow = render()
  expect(await workflow.clearHistory('wrong')).toBe(false)
  useSimpleUi.getState().patch(context.key, { pendingAction: true })
  expect(await workflow.clearHistory(context.key)).toBe(false)
  expect(clearSimpleChat).not.toHaveBeenCalled()
  useSimpleUi.getState().patch(context.key, { pendingAction: false })
  vi.mocked(clearSimpleChat).mockReturnValue(true)
  expect(await workflow.clearHistory(context.key)).toBe(true)
})
test('Plan delegates composer focus without starting an agent', async () => {
  render().act('plan')
  await idle()
  expect(context.focusComposer).toHaveBeenCalledOnce()
  expect(implementPlannerPlan).not.toHaveBeenCalled()
})

test('completion keeps launch ownership and leaves another scope pending', async () => {
  let finishFirst!: (value: { sessionId: string }) => void
  let finishOther!: (value: { sessionId: string }) => void
  vi.mocked(implementPlannerPlan)
    .mockReturnValueOnce(
      new Promise((done) => {
        finishFirst = done
      }),
    )
    .mockReturnValueOnce(
      new Promise((done) => {
        finishOther = done
      }),
    )
  render().act('build')
  useStore.setState({ activeTask: 'other' })
  const other = { key: simpleKey('p', 'other'), task: 'other' }
  render(other).act('build')
  finishFirst({ sessionId: 'first' })
  await idle()
  expect(logLaunch).toHaveBeenCalledWith(
    'p',
    null,
    expect.objectContaining({ sessionId: 'first' }),
    undefined,
    { atRunStart: true },
  )
  expect(render(other).pending).toBe('build')
  expect(useSimpleUi.getState().worktrees[other.key]?.pendingWorkflow).toBe(true)
  finishOther({ sessionId: 'other' })
  await vi.waitFor(() => expect(render(other).pending).toBe(''))
})

describe('Merge', () => {
  const source = { path: '/p/feature', branch: 'feature', head: 'f1' }
  const target = { path: '/p', branch: 'main', head: 'm1' }
  const merge = () => {
    vi.mocked(gitWorktrees).mockResolvedValue([source, target] as never)
    vi.mocked(mergeSourceChanges).mockResolvedValue([])
    vi.mocked(startMergeAgent).mockResolvedValue('merger')
    return { source, target } as unknown as Partial<Context>
  }
  test('without conflicts one click starts the merge agent', async () => {
    const sides = merge()
    vi.mocked(mergeConflicts).mockResolvedValue([])
    render(sides).act('checkMerge')
    await idle()
    expect(startMergeAgent).toHaveBeenCalledTimes(1)
    expect(useSimpleUi.getState().worktrees[context.key]?.mergeCheck).toBeUndefined()
  })
  test('conflicts stop the merge and stay shown for this worktree', async () => {
    const sides = merge()
    vi.mocked(mergeConflicts).mockResolvedValue(['src/a.ts'])
    render(sides).act('checkMerge')
    await idle()
    expect(startMergeAgent).not.toHaveBeenCalled()
    expect(useSimpleUi.getState().worktrees[context.key]?.mergeCheck).toEqual({
      key: JSON.stringify([context.key, 'f1', 'm1']),
      paths: ['src/a.ts'],
    })
    render(sides).act('merge')
    await idle()
    expect(mergeConflicts).toHaveBeenCalledTimes(1)
    expect(startMergeAgent).toHaveBeenCalledTimes(1)
    expect(useSimpleUi.getState().worktrees[context.key]?.mergeCheck).toBeUndefined()
  })
})
