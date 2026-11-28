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
  readChatTeams: vi.fn(),
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
import { controlTeam, readChatTeams, resetLead } from './chatTeams'
import { stopAuto } from './auto'
import type { AutoRun, Task } from '../types'
import { clearSimpleChat } from './simpleActions'
import { thread } from './simple'
type Context = Parameters<typeof useChatModeWorkflow>[0]
let context: Context
const other = { key: simpleKey('p', 'other'), task: 'other' }
const makeTeam = (task: Context['task']): NonNullable<Context['team']> =>
  ({
    id: task ?? 'main',
    projectId: 'p',
    task,
    state: 'running',
    lead: { sessionId: task ?? 'main' },
  }) as NonNullable<Context['team']>
function render(overrides: Partial<Context> = {}) {
  hooks.cursor = 0
  // The project's lead is the conversation's team wherever the focus is.
  const chat = { ...context.chat, team: overrides.team ?? context.chat.team }
  return Workflow({ ...context, chat, ...overrides })
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
  useStore.setState({
    project: { id: 'p', name: 'P', root: '/p' },
    tasks: [{ id: other.task, branch: other.task, worktree: '/other' } as Task],
  })
  context = {
    key: simpleKey('p', null),
    projectId: 'p',
    task: null,
    chat: {
      key: simpleKey('p', null),
      task: null,
      team: undefined,
      simple: null,
      model: thread(
        { records: [], sessions: {}, simple: null, auto: null },
        { projectId: 'p', task: null, path: '/p' },
      ),
    },
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
  const team = makeTeam(null)
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

test('a stale Stop confirmation leaves both worktrees untouched after switching', async () => {
  const team = makeTeam(null)
  const auto = { runId: 'run', status: 'running' } as AutoRun
  const workflow = render({ team, auto })
  const selection = workflow.selected('stop')
  useStore.setState({ activeTask: other.task })

  await workflow.work('stop', selection, workflow.tree)

  expect(stopAuto).not.toHaveBeenCalled()
  expect(readChatTeams).not.toHaveBeenCalled()
  expect(controlTeam).not.toHaveBeenCalled()
  const changed = expect.objectContaining({ message: expect.stringContaining('worktree changed') })
  expect(render({ team, auto }).workOutcomes).toEqual([
    { target: 'Auto', result: changed },
    { target: 'Chat coordination', result: changed },
  ])
  expect(render(other).workOutcomes).toEqual([])
})

test('Clear lead context resets the project’s lead whichever worktree is in focus', async () => {
  const team = makeTeam(null)
  const completed = vi.fn()
  useStore.setState({ activeTask: other.task })
  // A confirmation made for another conversation never resets this lead.
  await render({ ...other, team }).startFresh(other.key, completed)
  expect(resetLead).not.toHaveBeenCalled()
  await render({ ...other, team }).startFresh(context.key, completed)
  expect(resetLead).toHaveBeenCalledExactlyOnceWith(team)
  expect(completed).toHaveBeenCalledOnce()
})
