import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import {
  PLAN_SCOPE,
  TASK_ROOT_SCOPE,
  sessionId,
  type Project,
  type TerminalSnapshot,
} from '../types'
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => ({ connected: true, instanceId: 'test' })),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('./ipc', () => ({
  sessionsList: vi.fn(async () => []),
  sessionResume: vi.fn(async () => ''),
  terminalStart: vi.fn(async () => ''),
  terminalStop: vi.fn(async () => {}),
  serviceRetire: vi.fn(async () => {}),
  terminalSnapshot: vi.fn(async () => null),
  terminalCloseGuard: vi.fn(async () => 'lease'),
  releaseMapEdit: vi.fn(async () => {}),
  onTerminalEvent: vi.fn(async () => () => {}),
  planStart: vi.fn(),
  taskRootStart: vi.fn(),
  extensionTerminalRun: vi.fn(),
}))
vi.mock('../extensions/host', () => ({ executeExtensionCommand: vi.fn() }))
vi.mock('./planDrafts', () => ({ savePlanDraft: vi.fn(async () => {}) }))
vi.mock('./windows', () => ({ showsSession: vi.fn() }))
vi.mock('./git', () => ({ requestGitRefresh: vi.fn() }))
vi.mock('./terminals', () => ({
  disposeAll: vi.fn(),
  markOutputGeneration: vi.fn(),
  replayOutput: vi.fn(),
  restoreModes: vi.fn(),
  restoreOutput: vi.fn(),
  writeNote: vi.fn(),
  writeOutput: vi.fn(),
}))
const ipc = await import('./ipc')
const terminals = await import('./terminals')
const { savePlanDraft } = await import('./planDrafts')
const {
  closeTerminal,
  handleTerminalEvent,
  hydrateSession,
  startTerminal,
  restartTerminal,
  resetSessions,
  retireOlderService,
  withoutForgotten,
} = await import('./sessions')
const project: Project = {
  schemaVersion: 4,
  projectId: 'p',
  root: '/p',
  name: 'P',
  links: [],
  components: [
    {
      id: 'web',
      name: 'Web',
      path: '.',
      kind: 'app',
      notes: '',
      position: { x: 0, y: 0 },
      terminals: [{ id: 'dev', name: 'Dev', command: 'cat', kind: 'task' }],
    },
  ],
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ipc.terminalStart).mockResolvedValue('')
  vi.mocked(ipc.terminalStop).mockResolvedValue(undefined)
  vi.mocked(ipc.terminalSnapshot).mockResolvedValue(null)
  vi.mocked(ipc.sessionsList).mockResolvedValue([])
  resetSessions(0)
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject(project)
  useStore.setState({ serviceConnected: true })
})
const hasTerminal = () => useStore.getState().nodes[0].data.terminals.length === 1

test('close stops every worktree copy, including records unknown to this window', async () => {
  const own = sessionId('web', 'dev', null, 'p')
  const task = sessionId('web', 'dev', 'task', 'p')
  const foreign = sessionId('web', 'dev', null, 'other')
  vi.mocked(ipc.sessionsList).mockResolvedValue([
    { id: 'unhydrated', metadata: { projectId: 'p', componentId: 'web', terminalId: 'dev' } },
  ] as Awaited<ReturnType<typeof ipc.sessionsList>>)
  useStore.setState({ activeSession: task, revealed: { componentId: 'web', sid: task } })
  expect(await closeTerminal('web', 'dev')).toBe(true)
  const stopped = vi.mocked(ipc.terminalStop).mock.calls.map(([sid]) => sid)
  expect(stopped).toEqual(expect.arrayContaining([own, task, 'unhydrated']))
  expect(stopped).not.toContain(foreign)
  expect(hasTerminal()).toBe(false)
  expect(useStore.getState().activeSession).toBeNull()
  expect(useStore.getState().revealed).toBeNull()
  expect(ipc.releaseMapEdit).toHaveBeenCalledWith('p', 'lease')
})
test('close waits for a spawn without a started event, then stops it', async () => {
  const spawn = deferred()
  vi.mocked(ipc.terminalStart).mockImplementationOnce(async () => {
    await spawn.promise
    return ''
  })
  const start = startTerminal('web', 'dev')
  await vi.waitFor(() => expect(ipc.terminalStart).toHaveBeenCalled())
  const close = closeTerminal('web', 'dev')
  await startTerminal('web', 'dev', 'new-task')
  expect(ipc.terminalStart).toHaveBeenCalledTimes(1)
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  expect(hasTerminal()).toBe(true)
  spawn.resolve()
  await start
  expect(await close).toBe(true)
  expect(ipc.terminalStop).toHaveBeenCalledWith(sessionId('web', 'dev', null, 'p'))
})
test('close during the restart gap prevents its replacement spawn', async () => {
  const stop = deferred()
  vi.mocked(ipc.terminalStop).mockImplementationOnce(() => stop.promise)
  const restart = restartTerminal('web', 'dev')
  await vi.waitFor(() => expect(ipc.terminalStop).toHaveBeenCalled())
  const close = closeTerminal('web', 'dev')
  stop.resolve()
  await restart
  expect(await close).toBe(true)
  expect(ipc.terminalStart).not.toHaveBeenCalled()
})
test('failed stop keeps the saved terminal and releases its removal guard', async () => {
  sessionId('web', 'dev', null, 'p')
  vi.mocked(ipc.terminalStop).mockRejectedValueOnce(new Error('Disconnected'))
  expect(await closeTerminal('web', 'dev')).toBe(false)
  expect(hasTerminal()).toBe(true)
  expect(ipc.releaseMapEdit).toHaveBeenCalledWith('p', 'lease')
})
test.each([{ kind: 'implementPlan' }, { kind: 'fixFindings', reviewSession: 'review' }] as const)(
  '$kind propagates a failed launch to its handoff',
  async (kickoff) => {
    const terminalId = useStore.getState().addRootTerminal({
      id: 'agent',
      name: 'Agent',
      command: 'claude',
      kind: 'agent',
      category: 'Agents',
      source: 'builtin',
    })
    vi.mocked(ipc.taskRootStart).mockRejectedValueOnce(new Error('Launch failed'))
    await expect(
      startTerminal(TASK_ROOT_SCOPE, terminalId, null, 'p', { kickoff }),
    ).rejects.toThrow('Launch failed')
    // The handoff reports it; a toast here would show it twice.
    expect(useStore.getState().message ?? '').not.toContain('Launch failed')
  },
)
const agent = {
  id: 'agent',
  name: 'Agent',
  command: 'claude',
  kind: 'agent',
  category: 'Agents',
  source: 'builtin',
} as const
test('a fix agent started again is briefed over the whole map without saving plan drafts', async () => {
  useStore.setState({ highlighted: ['web'] })
  const terminalId = useStore.getState().addRootTerminal(agent)
  vi.mocked(ipc.taskRootStart).mockResolvedValue('')
  await startTerminal(TASK_ROOT_SCOPE, terminalId, null, 'p')
  expect(vi.mocked(ipc.taskRootStart).mock.lastCall?.[1]).toEqual(['web'])
  expect(vi.mocked(ipc.taskRootStart).mock.lastCall?.[5]).toBeUndefined()
  expect(savePlanDraft).toHaveBeenCalledTimes(1)
  const fixId = useStore.getState().addRootTerminal(agent)
  useStore.setState({
    sessionRecords: [
      {
        id: sessionId(TASK_ROOT_SCOPE, fixId, null, 'p'),
        metadata: { branch: 'feature' },
      } as never,
    ],
  })
  await startTerminal(TASK_ROOT_SCOPE, fixId, null, 'p')
  expect(vi.mocked(ipc.taskRootStart).mock.lastCall?.[1]).toEqual([])
  // No review named: the backend reads the branch from the terminal's own record.
  expect(vi.mocked(ipc.taskRootStart).mock.lastCall?.[5]).toEqual({ kind: 'fixFindings' })
  expect(savePlanDraft).toHaveBeenCalledTimes(1)
})
test('a fix terminal started again before the list reconciles is still a fix', async () => {
  const terminalId = useStore.getState().addRootTerminal(agent)
  useStore.setState({ sessionRecords: [] })
  vi.mocked(ipc.taskRootStart).mockResolvedValue('')
  const fix = { kind: 'fixFindings', reviewSession: 'review' } as const
  await startTerminal(TASK_ROOT_SCOPE, terminalId, null, 'p', { kickoff: fix })
  await startTerminal(TASK_ROOT_SCOPE, terminalId, null, 'p')
  expect(vi.mocked(ipc.taskRootStart).mock.lastCall?.[5]).toEqual({ kind: 'fixFindings' })
})
test('a handoff whose reply was lost counts as started once its session exists', async () => {
  const terminalId = useStore.getState().addRootTerminal(agent)
  vi.mocked(ipc.taskRootStart).mockRejectedValueOnce(new Error('Reply lost'))
  vi.mocked(ipc.terminalSnapshot).mockResolvedValueOnce({ running: false } as TerminalSnapshot)
  await expect(
    startTerminal(TASK_ROOT_SCOPE, terminalId, null, 'p', { kickoff: { kind: 'implementPlan' } }),
  ).resolves.toBeUndefined()
})
test('a failed handoff keeps no request id to retry with', async () => {
  const terminalId = useStore.getState().addRootTerminal(agent)
  vi.mocked(ipc.taskRootStart).mockRejectedValueOnce(new Error('Launch failed'))
  const fix = { kind: 'fixFindings', reviewSession: 'review' } as const
  await expect(
    startTerminal(TASK_ROOT_SCOPE, terminalId, null, 'p', { kickoff: fix }),
  ).rejects.toThrow()
  vi.mocked(ipc.taskRootStart).mockResolvedValueOnce('')
  await startTerminal(TASK_ROOT_SCOPE, terminalId, null, 'p', { kickoff: fix })
  const [first, second] = vi.mocked(ipc.taskRootStart).mock.calls.map((call) => call[4])
  expect(second).not.toBe(first)
})
test('a handoff learns its launch failed after sessions were reset', async () => {
  const terminalId = useStore.getState().addRootTerminal({
    id: 'agent',
    name: 'Agent',
    command: 'claude',
    kind: 'agent',
    category: 'Agents',
    source: 'builtin',
  })
  const start = deferred()
  vi.mocked(ipc.taskRootStart).mockImplementationOnce(async () => {
    await start.promise
    throw new Error('Launch failed')
  })
  const launch = startTerminal(TASK_ROOT_SCOPE, terminalId, null, 'p', {
    kickoff: { kind: 'fixFindings', reviewSession: 'review' },
  })
  await vi.waitFor(() => expect(ipc.taskRootStart).toHaveBeenCalled())
  resetSessions(0)
  start.resolve()
  await expect(launch).rejects.toThrow('Launch failed')
  // The reset made the error stale for everyone else.
  expect(useStore.getState().message).not.toContain('Launch failed')
})
test('tab switch while closing edits only the originating project', async () => {
  const stop = deferred()
  sessionId('web', 'dev', null, 'p')
  vi.mocked(ipc.terminalStop).mockImplementationOnce(() => stop.promise)
  const close = closeTerminal('web', 'dev')
  await vi.waitFor(() => expect(ipc.terminalStop).toHaveBeenCalled())
  useStore.getState().loadProject({ ...project, projectId: 'other', root: '/other' })
  stop.resolve()
  expect(await close).toBe(true)
  expect(hasTerminal()).toBe(true)
  expect(useStore.getState().captureProjects().p.state?.nodes[0].data.terminals).toEqual([])
})

test('reconciliation recovers merge records without registering generic runtime terminals', async () => {
  useStore.setState({ serviceInstance: 'test' })
  const record = {
    id: 'merge',
    metadata: {
      projectId: 'p',
      componentId: '@merge',
      terminalId: 'merge',
      name: 'Merge',
      kind: 'agent',
    },
    spec: { cwd: '/p', command: 'codex' },
    snapshot: null,
    history: [],
  } as unknown as import('../types').SessionRecord
  useStore.getState().addRuntimeTerminal('merge', {
    projectId: 'p',
    componentId: '@merge',
    terminal: { id: 'merge', name: 'Merge', kind: 'agent', command: 'codex' },
  })
  vi.mocked(ipc.sessionsList).mockResolvedValue([record])
  const { reconcileSessions } = await import('./sessions')
  await reconcileSessions()
  expect(useStore.getState().sessionRecords).toEqual([record])
  expect(useStore.getState().runtimeTerminals.merge).toBeUndefined()
  await reconcileSessions()
  expect(useStore.getState().runtimeTerminals.merge).toBeUndefined()
})

test('a post-launch reconcile waits for an older list before selecting and revealing the merge', async () => {
  const { reconcileSessions, reconcileFreshSessions } = await import('./sessions')
  useStore.setState({ serviceInstance: 'test' })
  useStore.getState().hideReviewAgent('old-merge')
  const pending = deferred()
  vi.mocked(ipc.sessionsList).mockImplementationOnce(async () => {
    await pending.promise
    return []
  })
  const prior = reconcileSessions()
  await vi.waitFor(() => expect(ipc.sessionsList).toHaveBeenCalledOnce())
  const record = {
    id: 'new-merge',
    metadata: { projectId: 'p', componentId: '@merge', terminalId: 'merge', kind: 'agent' },
    spec: { cwd: '/p', command: 'codex' },
    snapshot: null,
    history: [],
  } as unknown as import('../types').SessionRecord
  vi.mocked(ipc.sessionsList).mockResolvedValue([record])
  const fresh = reconcileFreshSessions()
  pending.resolve()
  await Promise.all([prior, fresh])
  expect(ipc.sessionsList).toHaveBeenCalledTimes(2)
  useStore.getState().setActiveSession(record.id)
  expect(useStore.getState().reviewAgents.p).toEqual({ sid: record.id, hidden: false })
  expect(useStore.getState().dockKept).not.toContain(record.id)
})
test('Start new launches fresh even when a recorded conversation exists', async () => {
  useStore.getState().updateTerminal('web', 'dev', { kind: 'agent', command: 'claude' })
  const sid = sessionId('web', 'dev', null, 'p')
  useStore.setState({
    sessionRecords: [{ id: sid, metadata: { adapter: 'claude', conversationId: 'abc' } } as never],
  })
  await startTerminal('web', 'dev')
  expect(ipc.terminalStart).toHaveBeenCalledWith(
    expect.anything(),
    'web',
    'dev',
    undefined,
    undefined,
    expect.any(String),
    undefined,
    false,
  )
  expect(ipc.sessionResume).not.toHaveBeenCalled()
  expect(ipc.sessionsList).not.toHaveBeenCalled()
})

test('restart sends an agent its current command and peers for service comparison', async () => {
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    ...project,
    components: [
      ...project.components,
      { ...project.components[0], id: 'api', name: 'API', terminals: [] },
    ],
  })
  useStore.getState().updateTerminal('web', 'dev', { kind: 'agent', command: 'claude --model new' })
  useStore.setState({ serviceConnected: true, highlighted: ['web', 'api'] })
  await restartTerminal('web', 'dev')
  expect(ipc.terminalStart).toHaveBeenCalledWith(
    expect.objectContaining({
      components: expect.arrayContaining([
        expect.objectContaining({
          terminals: [expect.objectContaining({ command: 'claude --model new', kind: 'agent' })],
        }),
      ]),
    }),
    'web',
    'dev',
    undefined,
    undefined,
    expect.any(String),
    ['web', 'api'],
    true,
  )
  expect(ipc.sessionsList).not.toHaveBeenCalled()
  expect(ipc.sessionResume).not.toHaveBeenCalled()
})

test('restarting a non-agent requests a fresh launch without conversation lookup', async () => {
  await restartTerminal('web', 'dev')
  expect(ipc.terminalStart).toHaveBeenCalledWith(
    expect.anything(),
    'web',
    'dev',
    undefined,
    undefined,
    expect.any(String),
    undefined,
    false,
  )
  expect(ipc.sessionsList).not.toHaveBeenCalled()
})

test('planner restart applies the current highlights and clears the scope warning', async () => {
  useStore.setState({ highlighted: ['web'] })
  await restartTerminal(PLAN_SCOPE, 'claude')
  expect(ipc.planStart).toHaveBeenCalledWith(
    expect.anything(),
    ['web'],
    expect.objectContaining({ kind: 'agent' }),
    expect.any(String),
    true,
    undefined,
    undefined,
  )
  const sid = sessionId(PLAN_SCOPE, 'claude', null, 'p')
  expect(useStore.getState().planStartedWith[sid]).toBe('web')
})

test('root agent restart prepares the current scope through taskRootStart', async () => {
  const terminalId = useStore.getState().addRootTerminal({
    id: 'agent',
    name: 'Agent',
    command: 'claude',
    kind: 'agent',
    category: 'Agents',
    source: 'builtin',
  })
  useStore.setState({ highlighted: ['web'] })
  await restartTerminal(TASK_ROOT_SCOPE, terminalId)
  expect(ipc.taskRootStart).toHaveBeenCalledWith(
    expect.anything(),
    ['web'],
    expect.objectContaining({ kind: 'agent' }),
    undefined,
    expect.any(String),
    undefined,
    true,
    undefined,
  )
})

test('an uncertain restart reply never triggers a second launch', async () => {
  useStore.getState().updateTerminal('web', 'dev', { kind: 'agent', command: 'claude' })
  vi.mocked(ipc.terminalStart).mockRejectedValueOnce(new Error('Reply lost'))
  await restartTerminal('web', 'dev')
  expect(ipc.terminalStart).toHaveBeenCalledTimes(1)
  expect(ipc.sessionResume).not.toHaveBeenCalled()
  expect(useStore.getState().message).toContain('Reply lost')
})

function snapshot(running: boolean, generation = 3): TerminalSnapshot {
  return {
    data: '',
    end: 0,
    generation,
    running,
    truncated: false,
    startedMs: 1,
    exitedMs: running ? null : 2,
    exitCode: running ? null : 0,
    status: {
      lastOutputMs: null,
      active: false,
      agent: null,
      url: null,
      ready: false,
      healthy: null,
      stopped: false,
      seenMs: null,
    },
    notice: null,
  }
}

test('hydrating a finished run resets the modes it left on, a running one keeps them', async () => {
  const ended = sessionId('web', 'dev', null, 'p')
  vi.mocked(ipc.terminalSnapshot).mockResolvedValueOnce(snapshot(false))
  await hydrateSession(ended)
  expect(terminals.restoreModes).toHaveBeenCalledWith(ended)
  vi.mocked(terminals.restoreModes).mockClear()
  const running = sessionId('web', 'dev', 'task', 'p')
  handleTerminalEvent({
    type: 'started',
    sessionId: running,
    generation: 3,
    startedMs: 1,
    notice: null,
  })
  vi.mocked(terminals.restoreModes).mockClear()
  vi.mocked(ipc.terminalSnapshot).mockResolvedValueOnce(snapshot(true))
  await hydrateSession(running)
  expect(terminals.restoreModes).not.toHaveBeenCalled()
  expect(useStore.getState().sessions[running].running).toBe(true)
})

test('hydrating an older finished snapshot preserves the live run and its terminal modes', async () => {
  const sid = sessionId('web', 'dev', null, 'p')
  handleTerminalEvent({
    type: 'started',
    sessionId: sid,
    generation: 4,
    startedMs: 4,
    notice: 'Current run',
  })
  handleTerminalEvent({ type: 'output', sessionId: sid, generation: 4, seq: 0, data: [65] })
  const current = useStore.getState().sessions[sid]
  vi.mocked(terminals.restoreModes).mockClear()
  vi.mocked(terminals.writeOutput).mockClear()
  vi.mocked(ipc.terminalSnapshot).mockResolvedValueOnce(snapshot(false))

  await hydrateSession(sid)

  expect(terminals.restoreModes).not.toHaveBeenCalled()
  expect(terminals.restoreOutput).not.toHaveBeenCalled()
  expect(terminals.replayOutput).not.toHaveBeenCalled()
  expect(useStore.getState().sessions[sid]).toEqual(current)
  handleTerminalEvent({ type: 'output', sessionId: sid, generation: 4, seq: 1, data: [66] })
  expect(terminals.writeOutput).toHaveBeenCalledWith(sid, [66])
})

test('all tiles share a stop that stays disabled until reconciliation', async () => {
  const stop = deferred()
  useStore.setState({ serviceConnected: false })
  vi.mocked(ipc.serviceRetire).mockImplementationOnce(() => stop.promise)
  const first = retireOlderService()
  expect(useStore.getState().serviceRetirement).toBe('stopping')
  await retireOlderService()
  expect(ipc.serviceRetire).toHaveBeenCalledTimes(1)
  stop.resolve()
  await first
  expect(useStore.getState().serviceRetirement).toBe('reconnecting')
  await retireOlderService()
  expect(ipc.serviceRetire).toHaveBeenCalledTimes(1)
})

test('a failed stop enables retry and shares its error', async () => {
  useStore.setState({ serviceConnected: false })
  vi.mocked(ipc.serviceRetire).mockRejectedValueOnce('connection lost')
  await retireOlderService()
  expect(useStore.getState().serviceRetirement).toBe('idle')
  expect(useStore.getState().serviceRetirementError).toBe('connection lost')
  await retireOlderService()
  expect(ipc.serviceRetire).toHaveBeenCalledTimes(2)
  expect(useStore.getState().serviceRetirement).toBe('reconnecting')
  expect(useStore.getState().serviceRetirementError).toBeUndefined()
})

test('a stale status reply cannot enable a stop before reconnection', async () => {
  const { invoke } = await import('@tauri-apps/api/core')
  const { reconcileSessions } = await import('./sessions')
  const status = deferred()
  vi.mocked(invoke).mockImplementationOnce(async () => {
    await status.promise
    return { connected: false, instanceId: '', retirement: { state: 'idle' } }
  })
  useStore.setState({ serviceConnected: false })
  const polling = reconcileSessions()
  await retireOlderService()
  expect(useStore.getState().serviceRetirement).toBe('reconnecting')
  status.resolve()
  await polling
  expect(useStore.getState().serviceRetirement).toBe('reconnecting')
  await retireOlderService()
  expect(ipc.serviceRetire).toHaveBeenCalledTimes(1)
})

test('reconciling drops the state of sessions the service forgot', () => {
  const record = (id: string) => ({ id }) as unknown as import('../types').SessionRecord
  const sessions = {
    kept: { running: false },
    forgotten: { running: false },
    local: { running: true },
  }
  // `local` was never listed (a launch not yet recorded), so it stays.
  expect(
    withoutForgotten(sessions, [record('kept'), record('forgotten')], [record('kept')]),
  ).toEqual({
    kept: { running: false },
    local: { running: true },
  })
  expect(withoutForgotten(sessions, [record('kept')], [record('kept')])).toBe(sessions)
})

test('Auto launch rejects when Close cancels it before IPC', async () => {
  const terminalId = useStore.getState().addRootTerminal({
    id: 'agent',
    name: 'Agent',
    command: 'claude',
    kind: 'agent',
    category: 'Agents',
    source: 'builtin',
  })
  const launch = startTerminal(TASK_ROOT_SCOPE, terminalId, null, 'p', {
    kickoff: { kind: 'implementPlan' },
  })
  const rejected = expect(launch).rejects.toThrow('The launch was cancelled')
  const close = closeTerminal(TASK_ROOT_SCOPE, terminalId)
  await rejected
  expect(await close).toBe(true)
  expect(ipc.terminalCloseGuard).toHaveBeenCalledWith('p', TASK_ROOT_SCOPE, terminalId)
  expect(ipc.taskRootStart).not.toHaveBeenCalled()
})

test('reset while the backend starts an Auto agent rejects the obsolete launch', async () => {
  const spawn = deferred()
  vi.mocked(ipc.taskRootStart).mockImplementationOnce(async () => {
    await spawn.promise
    return 'started'
  })
  const terminalId = useStore.getState().addRootTerminal({
    id: 'agent',
    name: 'Agent',
    command: 'claude',
    kind: 'agent',
    category: 'Agents',
    source: 'builtin',
  })
  const launch = startTerminal(TASK_ROOT_SCOPE, terminalId, null, 'p', {
    kickoff: { kind: 'implementPlan' },
  })
  const rejected = expect(launch).rejects.toThrow('The launch was cancelled')
  await vi.waitFor(() => expect(ipc.taskRootStart).toHaveBeenCalledOnce())
  resetSessions(1)
  vi.mocked(ipc.terminalSnapshot).mockResolvedValue({ running: true } as TerminalSnapshot)
  spawn.resolve()
  await rejected
})

test.each([false, true])(
  'Auto launch rejects on reset even with a stale running snapshot (%s)',
  async (running) => {
    vi.mocked(ipc.terminalSnapshot).mockResolvedValue({ running } as TerminalSnapshot)
    const terminalId = useStore.getState().addRootTerminal({
      id: 'agent',
      name: 'Agent',
      command: 'claude',
      kind: 'agent',
      category: 'Agents',
      source: 'builtin',
    })
    const launch = startTerminal(TASK_ROOT_SCOPE, terminalId, null, 'p', {
      kickoff: { kind: 'implementPlan' },
    })
    const rejected = expect(launch).rejects.toThrow('The launch was cancelled')
    resetSessions(1)
    await rejected
    expect(ipc.taskRootStart).not.toHaveBeenCalled()
  },
)

test('starting an agent an Auto run still tracks again sends its Auto brief and planner kickoff', async () => {
  const auto = { goal: 'Goal', fixFloor: 'medium' as const, effortNote: 'Note', commit: true }
  const fixId = useStore.getState().addRootTerminal(agent)
  const fixSid = sessionId(TASK_ROOT_SCOPE, fixId, null, 'p')
  const plannerSid = sessionId(PLAN_SCOPE, 'claude', null, 'p')
  const tracking = (
    sid: string,
    kickoff?: { kind: 'plan' },
    status: 'paused' | 'stopped' = 'paused',
  ) =>
    useStore.getState().patchTask('p', null, {
      auto: {
        runId: 'r',
        status,
        stage: 'fix',
        goal: 'Goal',
        effort: 'standard',
        merge: { mode: 'ask', destinationBranch: 'main' },
        device: 'claude',
        round: 1,
        log: [],
        sessionId: sid,
        sessionBrief: { sessionId: sid, auto, kickoff },
      },
    })
  vi.mocked(ipc.taskRootStart).mockResolvedValue('')
  tracking(fixSid)
  await startTerminal(TASK_ROOT_SCOPE, fixId, null, 'p')
  expect(vi.mocked(ipc.taskRootStart).mock.lastCall?.[7]).toEqual(auto)
  tracking(plannerSid, { kind: 'plan' })
  await restartTerminal(PLAN_SCOPE, 'claude')
  expect(vi.mocked(ipc.planStart).mock.lastCall?.slice(5)).toEqual([{ kind: 'plan' }, auto])
  // Once the run moved on, the terminal starts like any other.
  tracking('other')
  await startTerminal(TASK_ROOT_SCOPE, fixId, null, 'p')
  expect(vi.mocked(ipc.taskRootStart).mock.lastCall?.[7]).toBeUndefined()
  // A stopped run briefs nothing either.
  tracking(plannerSid, { kind: 'plan' }, 'stopped')
  await restartTerminal(PLAN_SCOPE, 'claude')
  expect(vi.mocked(ipc.planStart).mock.lastCall?.slice(5)).toEqual([undefined, undefined])
})
