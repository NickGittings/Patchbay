import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import { PLAN_SCOPE, TASK_ROOT_SCOPE, sessionId, type DeviceManifest } from '../types'

vi.mock('./ipc', () => ({
  planRead: vi.fn(),
  planWrite: vi.fn(),
  proposalRead: vi.fn(),
  proposalApply: vi.fn(),
  terminalStop: vi.fn(),
  storyUpdate: vi.fn(),
}))
vi.mock('./sessions', () => ({ startTerminal: vi.fn() }))
vi.mock('./tasks', () => ({ refreshTasks: vi.fn() }))
const ipc = await import('./ipc')
const { startTerminal } = await import('./sessions')
const { implementPlannerPlan } = await import('./planHandoff')
const { planDrafts } = await import('./planDrafts')
const claude: DeviceManifest = {
  id: 'claude',
  name: 'Claude',
  command: 'claude --model sonnet',
  adapter: 'claude',
  category: 'Agents',
  kind: 'agent',
  source: 'builtin',
}

beforeEach(() => {
  vi.resetAllMocks()
  planDrafts.clear()
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    name: 'Project',
    root: '/p',
    schemaVersion: 4,
    links: [],
    components: [
      {
        id: 'web',
        name: 'Web',
        path: '.',
        kind: 'app',
        notes: '',
        position: { x: 0, y: 0 },
        terminals: [],
      },
    ],
  })
  useStore.getState().setDevices([claude])
  useStore.getState().setView('plan')
  vi.mocked(ipc.planRead).mockResolvedValue({ text: '# Plan', cut: false })
  vi.mocked(ipc.planWrite).mockResolvedValue(true)
  vi.mocked(ipc.proposalRead).mockResolvedValue(null)
})

test('one click hands off a whole-project plan using the planner provider', async () => {
  const sid = sessionId(PLAN_SCOPE, 'claude', null, 'p')
  useStore.setState({ sessions: { [sid]: { running: true } } })
  await implementPlannerPlan('claude')
  const s = useStore.getState()
  expect(s.highlighted).toEqual([])
  expect(s.view).toBe('implementation')
  expect(ipc.terminalStop).toHaveBeenCalledWith(sid)
  expect(s.rootTerminals.at(-1)).toMatchObject({
    kind: 'agent',
    command: claude.command,
    adapter: 'claude',
  })
  expect(startTerminal).toHaveBeenCalledWith(
    TASK_ROOT_SCOPE,
    s.rootTerminals.at(-1)!.id,
    null,
    'p',
    { kickoff: { kind: 'implementPlan' } },
  )
})

test('the implement role, or an explicit preset, picks the implementation agent', async () => {
  const codex: DeviceManifest = { ...claude, id: 'codex', command: 'codex', adapter: 'codex' }
  const shell: DeviceManifest = { ...claude, id: 'zsh', command: 'zsh', kind: 'shell' }
  useStore.getState().setDevices([claude, codex, shell])
  useStore.getState().setAgentRoles({ implement: ['codex'] })
  await implementPlannerPlan('claude')
  expect(useStore.getState().rootTerminals.at(-1)).toMatchObject({ command: 'codex' })
  useStore.getState().setAgentRoles({ implement: ['gone'] })
  await implementPlannerPlan('codex')
  expect(useStore.getState().rootTerminals.at(-1)).toMatchObject({ command: 'codex' })
  useStore.getState().setAgentRoles({ implement: ['codex'] })
  await implementPlannerPlan('codex', undefined, 'claude')
  expect(useStore.getState().rootTerminals.at(-1)).toMatchObject({ command: claude.command })
  // Only agent presets count.
  await implementPlannerPlan('claude', undefined, 'zsh')
  expect(useStore.getState().rootTerminals.at(-1)).toMatchObject({ command: 'codex' })
})

test('each accepted plan receives a fresh briefing instead of reusing a running agent', async () => {
  useStore.getState().addRootTerminal(claude)
  const before = useStore.getState().rootTerminals.length
  await implementPlannerPlan('claude')
  expect(useStore.getState().rootTerminals).toHaveLength(before + 1)
})

test('Implement accepts the pending plan and assignments before starting', async () => {
  const proposal = {
    version: 1,
    plan: '# Scoped plan',
    assignments: [{ componentId: 'web', assignment: 'Fix login' }],
  }
  vi.mocked(ipc.proposalRead).mockResolvedValue(proposal)
  vi.mocked(ipc.proposalApply).mockResolvedValue(['web'])
  await implementPlannerPlan('claude')
  expect(ipc.proposalApply).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 'p' }),
    undefined,
    proposal,
    undefined,
  )
  expect(useStore.getState().highlighted).toEqual(['web'])
  expect(startTerminal).toHaveBeenCalledOnce()
})

test('a missing plan leaves the planner open and starts no agent', async () => {
  vi.mocked(ipc.planRead).mockResolvedValue({ text: ' ', cut: false })
  await expect(implementPlannerPlan('claude')).rejects.toThrow('No plan received yet')
  expect(useStore.getState().view).toBe('plan')
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  expect(startTerminal).not.toHaveBeenCalled()
})

test('a launch failure after stopping the planner stays in Plan and reports the error', async () => {
  const sid = sessionId(PLAN_SCOPE, 'claude', null, 'p')
  useStore.setState({ sessions: { [sid]: { running: true } } })
  vi.mocked(startTerminal).mockRejectedValue(new Error('Launch failed'))
  await expect(implementPlannerPlan('claude')).rejects.toThrow('Launch failed')
  expect(ipc.terminalStop).toHaveBeenCalledWith(sid)
  expect(useStore.getState().view).toBe('plan')
})

test('an empty project plan cannot reuse a previous worktree plan', async () => {
  useStore.setState({ activeTask: 'later' })
  vi.mocked(ipc.planRead).mockImplementation(async (_, task) => ({
    text: task ? '# Old worktree plan' : ' ',
    cut: false,
  }))
  await expect(implementPlannerPlan('claude')).rejects.toThrow('No plan received yet')
  expect(ipc.planWrite).not.toHaveBeenCalled()
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  expect(startTerminal).not.toHaveBeenCalled()
  expect(useStore.getState().view).toBe('plan')
})

test('saving an edited draft still applies the pending scope assignments', async () => {
  planDrafts.set('p\n', { text: 'Edited plan', base: '# Plan', overwrite: false })
  const proposal = {
    version: 1,
    plan: '# Earlier proposal',
    assignments: [{ componentId: 'web', assignment: 'Fix login' }],
  }
  vi.mocked(ipc.proposalRead).mockResolvedValue(proposal)
  vi.mocked(ipc.proposalApply).mockResolvedValue(['web'])
  await implementPlannerPlan('claude')
  expect(ipc.planWrite).toHaveBeenCalledWith('p', undefined, 'Edited plan', '# Plan')
  expect(ipc.proposalApply).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 'p' }),
    undefined,
    proposal,
    undefined,
  )
  expect(vi.mocked(ipc.planWrite).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(ipc.proposalApply).mock.invocationCallOrder[0],
  )
  expect(useStore.getState().highlighted).toEqual(['web'])
})

test('editor changes are saved first and conflicts block implementation', async () => {
  planDrafts.set('p\n', { text: 'Edited plan', base: '# Plan', overwrite: false })
  vi.mocked(ipc.planWrite).mockResolvedValue(false)
  await expect(implementPlannerPlan('claude')).rejects.toThrow('Review and save your edits')
  expect(startTerminal).not.toHaveBeenCalled()
  expect(ipc.terminalStop).not.toHaveBeenCalled()
})

test('switching tasks while reading the plan cannot launch into another task', async () => {
  vi.mocked(ipc.planRead).mockImplementation(async () => {
    useStore.setState({ activeTask: 'another-task' })
    return { text: '# Plan', cut: false }
  })
  await expect(implementPlannerPlan('claude')).rejects.toThrow('The task changed')
  expect(startTerminal).not.toHaveBeenCalled()
  expect(ipc.terminalStop).not.toHaveBeenCalled()
})

test('a plan made on the project folder is copied into the worktree it is implemented in', async () => {
  const sid = sessionId(PLAN_SCOPE, 'claude', null, 'p')
  useStore.setState({ sessions: { [sid]: { running: true } }, activeTask: 'later' })
  vi.mocked(ipc.planRead).mockImplementation(async (_, task) =>
    task ? { text: '# Copied', cut: false } : { text: '# Plan', cut: false },
  )
  await implementPlannerPlan('claude')
  expect(ipc.planWrite).toHaveBeenCalledWith('p', 'later', '# Plan', null)
  expect(ipc.terminalStop).toHaveBeenCalledWith(sid)
  expect(startTerminal).toHaveBeenCalledWith(
    TASK_ROOT_SCOPE,
    useStore.getState().rootTerminals.at(-1)!.id,
    'later',
    'p',
    { kickoff: { kind: 'implementPlan' } },
  )
})

test('a project-folder proposal is applied to the active worktree', async () => {
  useStore.setState({ activeTask: 'later' })
  const proposal = {
    version: 1,
    plan: '# Scoped plan',
    assignments: [{ componentId: 'web', assignment: 'Fix login' }],
  }
  vi.mocked(ipc.proposalRead).mockResolvedValue(proposal)
  vi.mocked(ipc.proposalApply).mockResolvedValue(['web'])
  await implementPlannerPlan('claude')
  expect(ipc.proposalRead).toHaveBeenCalledWith('p')
  expect(ipc.proposalApply).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 'p' }),
    undefined,
    proposal,
    'later',
  )
  expect(ipc.planWrite).not.toHaveBeenCalled()
})

test('implementing in the project folder copies nothing', async () => {
  await implementPlannerPlan('claude')
  expect(ipc.planWrite).not.toHaveBeenCalled()
  expect(ipc.planRead).toHaveBeenCalledWith('p', undefined)
})

test('Auto implements the project plan and returns the launched session', async () => {
  useStore.setState({ activeTask: 'later' })
  const auto = {
    goal: 'Finish the worktree task',
    fixFloor: null,
    effortNote: 'Add tests',
    commit: true,
  }
  const sid = await implementPlannerPlan('claude', auto)
  const terminalId = useStore.getState().rootTerminals.at(-1)!.id
  expect(sid).toBe(sessionId(TASK_ROOT_SCOPE, terminalId, 'later', 'p'))
  expect(startTerminal).toHaveBeenCalledWith(TASK_ROOT_SCOPE, terminalId, 'later', 'p', {
    kickoff: { kind: 'implementPlan' },
    auto,
  })
})

test('Auto never falls back to an older worktree plan', async () => {
  useStore.setState({ activeTask: 'later' })
  vi.mocked(ipc.planRead).mockImplementation(async (_, task) => ({
    text: task ? '# Old worktree plan' : '',
    cut: false,
  }))
  await expect(
    implementPlannerPlan('claude', { goal: 'g', fixFloor: null, effortNote: '', commit: true }),
  ).rejects.toThrow('No plan received yet')
  expect(ipc.planWrite).not.toHaveBeenCalled()
  expect(startTerminal).not.toHaveBeenCalled()
})

test('Auto handing off a manual planner stops it before implementation', async () => {
  const planner = sessionId(PLAN_SCOPE, 'claude', null, 'p')
  useStore.setState({ sessions: { [planner]: { running: true } } })
  await implementPlannerPlan('claude', {
    goal: 'Goal',
    fixFloor: null,
    effortNote: '',
    commit: true,
  })
  expect(ipc.terminalStop).toHaveBeenCalledWith(planner)
  expect(startTerminal).toHaveBeenCalledOnce()
})

test('overlapping Auto and manual plan approvals launch only one implementation', async () => {
  let finish!: () => void
  vi.mocked(startTerminal).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const auto = implementPlannerPlan('claude', {
    goal: 'Goal',
    fixFloor: null,
    effortNote: '',
    commit: true,
  })
  await vi.waitFor(() => expect(startTerminal).toHaveBeenCalledOnce())
  await expect(implementPlannerPlan('claude')).rejects.toThrow('already being implemented')
  finish()
  await auto
  expect(startTerminal).toHaveBeenCalledOnce()
})

test('manual and Auto implementation kickoffs use the project subagent count', async () => {
  useStore.getState().setImplementSubagents(3)
  const auto = { goal: 'Ship the task', fixFloor: null, effortNote: '', commit: false }
  for (const brief of [undefined, auto]) {
    await implementPlannerPlan('claude', brief)
    expect(startTerminal).toHaveBeenLastCalledWith(
      TASK_ROOT_SCOPE,
      useStore.getState().rootTerminals.at(-1)!.id,
      null,
      'p',
      { kickoff: { kind: 'implementPlan', subagents: 3 }, auto: brief },
    )
  }
})

test('Implement reads the latest subagent setting after awaiting the planner stop', async () => {
  const planner = sessionId(PLAN_SCOPE, 'claude', null, 'p')
  useStore.setState({ sessions: { [planner]: { running: true } } })
  useStore.getState().setImplementSubagents(3)
  let finish!: () => void
  vi.mocked(ipc.terminalStop).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const handoff = implementPlannerPlan('claude')
  await vi.waitFor(() => expect(ipc.terminalStop).toHaveBeenCalledWith(planner))
  expect(startTerminal).not.toHaveBeenCalled()
  useStore.getState().setImplementSubagents(5)
  finish()
  await handoff
  expect(startTerminal).toHaveBeenCalledWith(
    TASK_ROOT_SCOPE,
    useStore.getState().rootTerminals.at(-1)!.id,
    null,
    'p',
    { kickoff: { kind: 'implementPlan', subagents: 5 } },
  )
})

test('Implement links the planner story to its worktree only after launch succeeds', async () => {
  const item = {
    id: 'story1',
    kind: 'story' as const,
    parent: null,
    title: 'Story',
    description: '',
    acceptance: [],
    components: [],
    task: null,
    status: 'planned' as const,
    createdMs: 1,
    order: 0,
  }
  useStore.setState({
    stories: [item],
    activeTask: 'task1',
    planStory: 'story1',
    planStoryTerminal: 'claude',
  })
  vi.mocked(ipc.storyUpdate).mockResolvedValue({ ...item, task: 'task1' })
  vi.mocked(startTerminal).mockRejectedValueOnce(new Error('Failed'))
  await expect(implementPlannerPlan('claude')).rejects.toThrow('Failed')
  expect(ipc.storyUpdate).not.toHaveBeenCalled()
  await implementPlannerPlan('claude')
  expect(ipc.storyUpdate).toHaveBeenCalledWith('p', 'story1', { task: 'task1' })
  expect(useStore.getState().stories[0].task).toBe('task1')
})

test('a handoff preserves a pending story belonging to another planner', async () => {
  const item = { id: 'story', task: null } as unknown as import('../types').Story
  useStore.setState({
    stories: [item],
    activeTask: 'task',
    planStory: 'story',
    planStoryTerminal: 'different',
  })
  await implementPlannerPlan('claude', undefined, undefined, 'stay')
  expect(ipc.storyUpdate).not.toHaveBeenCalled()
  expect(useStore.getState()).toMatchObject({
    planStory: 'story',
    planStoryTerminal: 'different',
  })
})
