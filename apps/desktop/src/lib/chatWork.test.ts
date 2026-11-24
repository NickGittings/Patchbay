import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import type { AutoRun, Task } from '../types'
import { autoRun, stopAuto } from './auto'
import { controlTeam, readChatTeams, teamFor, type ChatTeam } from './chatTeams'
import { applyWorkSelection, controlWork, teamResumeBlocker, workSelection } from './chatWork'
import type { ProviderRun } from './orchestration'
import { worktreeIdentity } from './workBlocker'

vi.mock('./chatTeams', () => ({
  controlTeam: vi.fn(),
  readChatTeams: vi.fn(),
  teamFor: vi.fn(),
  useChatTeams: { getState: () => ({ runs: {} }) },
}))
vi.mock('./auto', () => ({
  autoRun: () => useStore.getState().auto,
  stopAuto: vi.fn(),
}))

const target = { projectId: 'p', task: 'feature' }
const team = (state: ChatTeam['state']): ChatTeam =>
  ({
    ...target,
    id: 'team',
    target: '/feature',
    lead: { sessionId: 'lead', generation: 1 },
    state,
    reset: null,
  }) as ChatTeam
const auto = (status: AutoRun['status']): AutoRun =>
  ({
    runId: 'auto',
    goal: 'Ship',
    status,
    stage: 'review',
    branch: 'feature',
  }) as AutoRun

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState(useStore.getInitialState())
  useStore.setState({
    project: { id: 'p', root: '/p', name: 'Patchbay' },
    activeTask: 'feature',
    tasks: [{ id: 'feature', branch: 'feature', worktree: '/feature' } as Task],
  })
})

test('Continue applies to paused Auto even while Chat coordination is running', () => {
  const paused = auto('paused')
  expect(workSelection('continue', team('running'), paused)).toEqual({
    team: undefined,
    auto: paused,
  })
  const starting = auto('waitingOnYou')
  expect(workSelection('pause', team('paused'), starting)).toEqual({
    team: undefined,
    auto: starting,
  })
})

test('Stop only includes eligible work in the confirmation', () => {
  const paused = auto('paused')
  expect(workSelection('stop', team('stopped'), paused)).toEqual({ team: undefined, auto: paused })
  const running = team('running')
  expect(workSelection('stop', running, auto('done'))).toEqual({ team: running, auto: undefined })
})

test('a refused Chat continuation retains its recovery action when Auto succeeds', async () => {
  const coordination = team('paused')
  const run = auto('paused')
  const failedWorker = teamResumeBlocker(coordination, [
    {
      chatTeam: coordination.id,
      state: 'paused',
      jobs: [{ id: 'job', state: 'failed', terminal: { name: 'Sub-builder A' } }],
    } as ProviderRun,
  ])
  const operations = {
    team: vi.fn(async () => {
      throw failedWorker
    }),
    auto: vi.fn(async () => {}),
  }
  expect(
    await applyWorkSelection('continue', workSelection('continue', coordination, run), operations),
  ).toEqual([
    { target: 'Chat coordination', result: failedWorker },
    { target: 'Auto', result: 'continued' },
  ])
  expect(failedWorker?.recovery).toEqual({
    kind: 'failedWorker',
    assignment: 'job',
    name: 'Sub-builder A',
    target,
  })
  expect(operations.auto).toHaveBeenCalledWith(run)
})

test('an outdated team confirmation leaves the new lead running while the selected Auto run stops', async () => {
  const coordination = team('running')
  const run = auto('paused')
  const newTeam = { ...coordination, lead: { ...coordination.lead, generation: 2 } }
  useStore.setState({ auto: run })
  vi.mocked(readChatTeams).mockResolvedValue([newTeam])
  vi.mocked(teamFor).mockReturnValue(newTeam)
  const selected = workSelection('stop', coordination, run)
  expect(await controlWork('stop', target, worktreeIdentity(target), selected)).toEqual([
    { target: 'Auto', result: 'stopped' },
    {
      target: 'Chat coordination',
      result: expect.objectContaining({ recovery: { kind: 'refreshLead', projectId: 'p' } }),
    },
  ])
  expect(stopAuto).toHaveBeenCalledWith('p', 'feature', run)
  expect(controlTeam).not.toHaveBeenCalled()
})

test('Stop refuses a changed checkout or replacement run', async () => {
  const tree = worktreeIdentity(target)
  const run = auto('paused')
  const selected = workSelection('stop', undefined, run)
  useStore.setState({ auto: { ...run, runId: 'replacement' } })
  expect(await controlWork('stop', target, tree, selected)).toEqual([
    { target: 'Auto', result: expect.objectContaining({ recovery: { kind: 'auto', target } }) },
  ])
  useStore.setState({ auto: run })
  useStore.setState((s) => ({ tasks: s.tasks.map((task) => ({ ...task, branch: 'moved' })) }))
  expect(await controlWork('stop', target, tree, selected)).toEqual([
    {
      target: 'Auto',
      result: expect.objectContaining({ message: expect.stringContaining('worktree changed') }),
    },
  ])
  expect(stopAuto).not.toHaveBeenCalled()
  expect(autoRun('p', 'feature')).toBe(run)
})
