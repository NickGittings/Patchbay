import { beforeEach, expect, test, vi } from 'vitest'
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
vi.mock('./chatTeams', () => ({
  controlTeam: vi.fn(),
  resetLead: vi.fn(),
  teamFor: vi.fn(),
}))
vi.mock('./auto', () => ({
  autoRun: vi.fn(),
  pauseAuto: vi.fn(),
  resumeAuto: vi.fn(),
  stopAuto: vi.fn(),
}))
vi.mock('./simpleComposer', () => ({ interruptSession: vi.fn() }))
vi.mock('./simpleActions', () => ({ clearSimpleChat: vi.fn() }))
import { useStore } from '../store'
import { simpleKey, useSimpleUi } from './simpleUi'
import { useChatModeWorkflow } from './useChatModeWorkflow'
import { resetLead } from './chatTeams'
import { clearSimpleChat } from './simpleActions'
import { thread } from './simple'
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
  context = {
    key: simpleKey('p', null),
    projectId: 'p',
    task: null,
    model: thread(
      { records: [], sessions: {}, simple: null, auto: null },
      { projectId: 'p', task: null, path: '/p' },
    ),
    source: undefined,
    auto: null,
    simple: null,
    changed: [],
    team: undefined,
    focusComposer: vi.fn(),
  }
})
test('a pending reset blocks another reset in the same worktree and releases the lock after failure', async () => {
  let reject!: (error: Error) => void
  vi.mocked(resetLead).mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail
    }),
  )
  const completed = vi.fn()
  const team = { id: 'team', lead: { sessionId: 'lead' } } as Context['team']
  const first = render({ team }).startFresh(context.key, completed)
  await render({ team }).startFresh(context.key, completed)
  expect(resetLead).toHaveBeenCalledOnce()
  expect(await render({ team }).clearHistory(context.key)).toBe(false)
  reject(new Error('reset failed'))
  await first
  await idle()
  expect(render({ team }).failure?.message).toBe('reset failed')
  expect(completed).not.toHaveBeenCalled()
  await render({ team }).startFresh(context.key, completed)
  expect(resetLead).toHaveBeenCalledTimes(2)
  expect(completed).toHaveBeenCalledOnce()
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
