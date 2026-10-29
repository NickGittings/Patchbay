import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import {
  TASK_ROOT_SCOPE,
  TERMINAL_RUNNING,
  type AutoRun,
  type SessionRecord,
  type ReviewFindings,
  type SessionState,
  type Worktree,
} from '../types'
vi.mock('./ipc', () => ({
  usageRead: vi.fn().mockResolvedValue(null),
  agentHooksCheck: vi.fn(),
  agentProvider: vi.fn(),
  gitBranches: vi.fn(),
  gitReview: vi.fn(),
  gitWorktrees: vi.fn(),
  graphActionRun: vi.fn(),
  mergeOutcome: vi.fn(),
  planRead: vi.fn(),
  proposalRead: vi.fn(),
  reviewRead: vi.fn(),
  terminalStop: vi.fn(),
  terminalSnapshot: vi.fn(),
  graphValidationCancel: vi.fn(),
}))
vi.mock('./sessions', () => ({
  startTerminal: vi.fn(),
  reconcileFreshSessions: vi.fn(),
  listenForTerminals: vi.fn(),
  refreshSession: vi.fn(),
}))
vi.mock('./planHandoff', () => ({ implementPlannerPlan: vi.fn() }))
vi.mock('./reviewHandoff', () => ({ fixReviewFindings: vi.fn() }))
vi.mock('./reviewAgents', async () => {
  const actual = await vi.importActual<typeof import('./reviewAgents')>('./reviewAgents')
  const startReviewAgent = vi.fn()
  return {
    ...actual,
    startReviewAgent,
    startMergeAgent: vi.fn(),
    // Through the mocked single launch, as the real one does, with a lane per reviewer of a round.
    startReviewAgents: vi.fn(
      async (...[project, request, devices, auto]: Parameters<typeof actual.startReviewAgents>) => {
        const sessions: string[] = []
        for (const device of devices)
          sessions.push(
            await startReviewAgent(
              project,
              devices.length > 1 ? { ...request, lane: device.id, round: 'round' } : request,
              device,
              'request',
              auto,
            ),
          )
        await (await import('./sessions')).reconcileFreshSessions()
        return {
          started: sessions.map((sessionId, i) => ({
            sessionId,
            requestId: `request-${sessionId}`,
            lane: devices.length > 1 ? devices[i].id : null,
          })),
          round: 'round',
          errors: [],
        }
      },
    ),
  }
})
const {
  inferStage,
  nextStep,
  reviewDecision,
  mergeableHead,
  blockingCount,
  validationFailures,
  autoSnapshot,
  stopAuto,
  startAuto,
  followAuto,
  pauseAuto,
  resumeAuto,
  mergeNow,
  skipStage,
  autoRun,
  agentFor,
  runAgents,
} = await import('./auto')
const ipc = await import('./ipc')
const jobs = await import('./reviewAgents')
const awaitSessions = await import('./sessions')
const tree: Worktree = {
  path: '/p/feature',
  branch: 'feature',
  head: 'abc',
  current: false,
  main: false,
}
const run = (patch: Partial<AutoRun> = {}): AutoRun => ({
  runId: 'run',
  status: 'running',
  stage: 'review',
  goal: 'Goal',
  effort: 'standard',
  merge: { mode: 'ask', destinationBranch: 'main' },
  device: 'codex',
  round: 0,
  log: [],
  ...patch,
})
const findings = (
  counts: Partial<NonNullable<ReviewFindings['verdict']>['counts']> = {},
): ReviewFindings => ({
  text: 'Verdict: issues',
  verdict: {
    clean: Object.keys(counts).length === 0,
    counts: { critical: 0, high: 0, medium: 0, low: 0, ...counts },
  },
  reviewedHead: 'abc',
  modifiedMs: 1100,
  startedMs: 1001,
  base: 'main',
  round: 'round',
  editedSinceStart: false,
  uncovered: false,
  truncated: false,
  reviewers: [],
})
const snapshot = (
  patch: Partial<import('./auto').AutoSnapshot> = {},
): import('./auto').AutoSnapshot => ({
  source: tree,
  worktrees: [tree],
  base: 'main',
  goal: 'Goal',
  plan: '',
  proposal: false,
  planMark: '',
  hasChanges: false,
  changedComponents: [],
  findings: null,
  freshness: 'none',
  outcome: 'notMerged',
  agents: [],
  ...patch,
})
beforeEach(() => {
  vi.resetAllMocks()
  useStore.setState(useStore.getInitialState())
})
afterEach(() => vi.useRealTimers())
test.each([
  [
    'busy before landed merge',
    { outcome: 'merged', agents: [{ sessionId: 's', stage: 'fix', state: 'working', sinceMs: 1 }] },
    'fix',
    'running',
  ],
  [
    'needs input',
    { agents: [{ sessionId: 's', stage: 'review', state: 'needsInput', sinceMs: 1 }] },
    'review',
    'waitingOnYou',
  ],
  ['merged', { outcome: 'merged' }, 'done', 'done'],
  ['integrated', { outcome: 'alreadyIntegrated' }, 'done', 'done'],
  ['clean', { freshness: 'current', findings: findings() }, 'mergeGate', 'running'],
  ['blocking', { freshness: 'current', findings: findings({ high: 1 }) }, 'fix', 'running'],
  ['low', { freshness: 'current', findings: findings({ low: 1 }) }, 'mergeGate', 'running'],
  [
    'stale implementation',
    { hasChanges: true, freshness: 'stale', plan: 'Plan' },
    'validate',
    'running',
  ],
  [
    'manual plan and committed implementation',
    { hasChanges: true, plan: 'Plan' },
    'validate',
    'running',
  ],
  ['old plan only', { plan: '# Plan' }, 'plan', 'running'],
  ['old proposal only', { proposal: true }, 'plan', 'running'],
  ['new task', {}, 'plan', 'running'],
] as const)('%s', (_name, input, stage, status) =>
  expect(
    inferStage(snapshot(input as Partial<import('./auto').AutoSnapshot>), run()),
  ).toMatchObject({ stage, status }),
)
test("each stage launches its own preset, else the run's single one", () => {
  const split = run({ device: 'claude', agents: { implement: 'codex', fix: 'codex', plan: '' } })
  expect(agentFor(split, 'plan')).toBe('claude')
  expect(agentFor(split, 'implement')).toBe('codex')
  expect(agentFor(split, 'review')).toBe('claude')
  expect(runAgents(split)).toEqual(['claude', 'codex'])
  expect(runAgents(run())).toEqual(['codex'])
})

test('Light reviews directly; budgets and verdicts are never guessed', () => {
  expect(inferStage(snapshot({ hasChanges: true }), run({ effort: 'light' })).stage).toBe('review')
  expect(
    inferStage(
      snapshot({ freshness: 'current', findings: findings({ high: 2 }) }),
      run({ round: 3 }),
    ).status,
  ).toBe('waitingOnYou')
  expect(nextStep(run(), { ...findings(), verdict: null }).status).toBe('paused')
  expect(nextStep(run(), { ...findings(), truncated: true }).status).toBe('paused')
})
test.each(['light', 'standard', 'thorough'] as const)(
  '%s severity and budget decisions',
  (effort) => {
    expect(nextStep(run({ effort }), findings({ high: 1 })).stage).toBe('fix')
    expect(nextStep(run({ effort, round: 100 }), findings({ high: 1 })).status).toBe('waitingOnYou')
    expect(nextStep(run({ effort }), findings({ low: 1 })).stage).toBe(
      effort === 'thorough' ? 'fix' : 'mergeGate',
    )
    expect(nextStep(run({ effort, stage: 'fix' })).stage).toBe(
      effort === 'light' ? 'review' : 'validate',
    )
  },
)
test('merge approval, verified outcome, overrides and validation failures', () => {
  expect(nextStep(run({ stage: 'mergeGate' })).status).toBe('waitingOnYou')
  const automatic = { mode: 'auto' as const, destinationBranch: 'main' }
  expect(nextStep(run({ stage: 'mergeGate', merge: automatic, reviewedHead: 'abc' })).stage).toBe(
    'merge',
  )
  // An unreviewed branch never merges automatically.
  expect(nextStep(run({ stage: 'mergeGate', merge: automatic })).status).toBe('waitingOnYou')
  expect(nextStep(run({ stage: 'merge' }), null, 'dirty').status).toBe('waitingOnYou')
  expect(nextStep(run({ stage: 'merge' }), null, 'merged').status).toBe('done')
  expect(blockingCount(findings({ critical: 1, high: 2, medium: 3, low: 4 }), 'medium')).toBe(6)
  expect(
    nextStep(run({ overrides: { severityFloor: 'low', maxRounds: 0 } }), findings({ low: 1 }))
      .status,
  ).toBe('waitingOnYou')
  expect(nextStep(run({ validationFindings: 'Failed check' }), findings()).stage).toBe('fix')
})
function load() {
  vi.mocked(jobs.startMergeAgent).mockResolvedValue('merge-s')
  const { reconcileFreshSessions } = awaitSessions
  vi.mocked(reconcileFreshSessions).mockImplementation(async () => {
    const sessions = { ...useStore.getState().sessions }
    for (const sid of ['merge-s', 'implementation'])
      sessions[sid] ??= { running: true, startedMs: Date.now() }
    useStore.setState({ sessions })
  })
  useStore.getState().loadProject({
    projectId: 'p',
    root: '/p',
    name: 'P',
    schemaVersion: 4,
    components: [],
    links: [],
  })
  useStore.setState({
    tasks: [
      {
        id: 't',
        title: 'Task',
        worktree: tree.path,
        branch: 'feature',
        base: 'main',
        notes: '',
        components: [],
        createdMs: 0,
        missing: false,
        current: false,
      },
    ],
    devices: [
      {
        id: 'codex',
        name: 'Codex',
        adapter: 'codex',
        command: 'codex',
        kind: 'agent',
        source: 'builtin',
        category: 'agent',
      },
    ],
    restoring: false,
    serviceConnected: true,
  })
  useStore.getState().setActiveTask('t')
  vi.mocked(ipc.usageRead).mockResolvedValue({
    claude: null,
    codex: null,
    claudeCapture: { installed: false, source: '/settings.json', chained: null },
    claudeError: null,
    codexError: null,
  })
  vi.mocked(ipc.terminalStop).mockResolvedValue(undefined)
  vi.mocked(ipc.agentProvider).mockResolvedValue('codex')
  vi.mocked(ipc.agentHooksCheck).mockResolvedValue({
    installed: true,
    disabled: false,
    reporterAvailable: true,
  } as Awaited<ReturnType<typeof ipc.agentHooksCheck>>)
  vi.mocked(ipc.gitWorktrees).mockResolvedValue([
    tree,
    { ...tree, path: '/p', branch: 'main', current: true },
  ])
  vi.mocked(ipc.gitBranches).mockResolvedValue(['main', 'feature'])
  vi.mocked(ipc.gitReview).mockResolvedValue({ ahead: true, changes: {}, affected: [] })
  vi.mocked(ipc.planRead).mockResolvedValue({ text: '', cut: false })
  vi.mocked(ipc.proposalRead).mockResolvedValue(null)
  vi.mocked(ipc.reviewRead).mockResolvedValue(null)
  vi.mocked(ipc.mergeOutcome).mockResolvedValue('notMerged')
}
function setRun(patch: Partial<AutoRun> = {}) {
  useStore.getState().patchTask('p', 't', { auto: run(patch) })
}
async function withFollower(check: (dispose: () => void) => Promise<void>) {
  const dispose = followAuto()
  try {
    await check(dispose)
  } finally {
    dispose()
  }
}
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
function agent(
  state: 'review' | 'working' | 'needsInput' | 'idle',
  sinceMs: number,
  authoritative = true,
) {
  useStore.setState({
    sessions: {
      s: {
        running: true,
        startedMs: 1000,
        status: {
          stopped: false,
          agent: { state, sinceMs, authoritative, message: null, prompt: null },
        },
      } as SessionState,
    },
  })
}
test('driver requires a new authoritative turn and stops reviewer before gating', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  vi.mocked(jobs.startReviewAgent).mockImplementation(async () => {
    agent('working', 1001)
    return 's'
  })
  await withFollower(async () => {
    await startAuto('p', 't', {
      goal: 'Goal',
      effort: 'light',
      merge: { mode: 'ask', destinationBranch: 'main' },
      device: 'codex',
    })
    await flush()
    expect(jobs.startReviewAgent).toHaveBeenCalledTimes(1)
    agent('review', 1100, false)
    await flush()
    expect(autoRun('p', 't')?.stage).toBe('review')
    agent('review', 999)
    await flush()
    expect(autoRun('p', 't')?.stage).toBe('review')
    vi.mocked(ipc.reviewRead).mockResolvedValue(findings())
    agent('review', 1200)
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ stage: 'mergeGate', status: 'waitingOnYou' })
    expect(ipc.terminalStop).toHaveBeenCalledWith('s')
    expect(jobs.startMergeAgent).not.toHaveBeenCalled()
    mergeNow('p', 't')
    await flush()
    expect(jobs.startMergeAgent).toHaveBeenCalledTimes(1)
  })
})
test('parallel reviewers share a round; the run waits for all, then stops the others', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  const codex = useStore.getState().devices[0]
  useStore.setState({
    devices: [codex, { ...codex, id: 'claude', name: 'Claude', command: 'claude' }],
  })
  const reviewer = (state: 'working' | 'review', sinceMs: number) =>
    ({
      running: true,
      startedMs: 1000,
      status: {
        stopped: false,
        agent: { state, sinceMs, authoritative: true, message: null, prompt: null },
      },
    }) as SessionState
  const lane = {
    id: 'lane',
    metadata: { projectId: 'p', componentId: '@review', kind: 'agent', name: 'Review' },
    spec: { cwd: tree.path, command: 'claude' },
    snapshot: null,
    history: [],
    interrupted: false,
  } as unknown as SessionRecord
  const set = (own: SessionState, other: SessionState) =>
    useStore.setState({ sessions: { s: own, lane: other }, sessionRecords: [lane] })
  vi.mocked(jobs.startReviewAgent).mockImplementation(async (_p, request) => {
    set(reviewer('working', 1001), reviewer('working', 1001))
    return request.lane === 'claude' ? 'lane' : 's'
  })
  await withFollower(async () => {
    await startAuto('p', 't', {
      goal: 'Goal',
      effort: 'light',
      merge: { mode: 'ask', destinationBranch: 'main' },
      device: 'codex',
      reviewers: ['codex', 'claude'],
    })
    await flush()
    expect(vi.mocked(jobs.startReviewAgent).mock.calls.map(([, r]) => r.lane)).toEqual([
      'codex',
      'claude',
    ])
    expect(autoRun('p', 't')).toMatchObject({
      sessionId: 's',
      laneSessions: [{ sessionId: 'lane', startedMs: 1000 }],
    })
    // The tracked reviewer is done, the other still writes: no verdict yet, and no pause.
    vi.mocked(ipc.reviewRead).mockResolvedValue({ ...findings(), reviewedHead: null })
    set(reviewer('review', 1200), reviewer('working', 1001))
    await flush()
    await vi.advanceTimersByTimeAsync(35000)
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      stage: 'review',
      status: 'running',
      reason: 'Waiting for reviewers to finish',
    })
    vi.mocked(ipc.reviewRead).mockResolvedValue(findings())
    set(reviewer('review', 1200), reviewer('review', 36000))
    await vi.advanceTimersByTimeAsync(5000)
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ stage: 'mergeGate', laneSessions: undefined })
    expect(ipc.terminalStop).toHaveBeenCalledWith('s')
    expect(ipc.terminalStop).toHaveBeenCalledWith('lane')
  })
})

function reviewSession(
  state: 'working' | 'review' | 'needsInput' | 'idle' | 'ended',
  sinceMs = 1200,
) {
  return {
    running: true,
    startedMs: 1000,
    status: {
      stopped: false,
      agent: { state, sinceMs, authoritative: true, message: null, prompt: null },
    },
  } as SessionState
}

test.each(['working', 'review'] as const)(
  'a second reviewer prompts for input while the primary is %s, then resumes',
  async (primary) => {
    vi.useFakeTimers()
    vi.setSystemTime(2000)
    load()
    setRun({
      sessionId: 's',
      sessionStartedMs: 1000,
      turnSince: 1000,
      launchAtMs: 1000,
      laneSessions: [{ sessionId: 'lane', startedMs: 1000 }],
    })
    useStore.setState({
      sessions: { s: reviewSession(primary), lane: reviewSession('needsInput') },
    })
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')).toMatchObject({
        status: 'waitingOnYou',
        waitingFor: 'agentInput',
        inputSessionId: 'lane',
        sessionId: 's',
      })
      useStore.setState({
        sessions: { s: reviewSession(primary), lane: reviewSession('working', 1500) },
      })
      await flush()
      expect(autoRun('p', 't')).toMatchObject({ status: 'running', inputSessionId: undefined })
      // A second prompt is surfaced immediately, even while waiting for another reviewer.
      useStore.setState({
        sessions: { s: reviewSession(primary), lane: reviewSession('needsInput', 1700) },
      })
      await flush()
      expect(autoRun('p', 't')?.status).toBe('waitingOnYou')
    })
  },
)

test.each(['crashed', 'ended', 'stopped', 'relaunched', 'forgotten'] as const)(
  'a secondary reviewer that %s pauses Auto with its session reason',
  async (failure) => {
    load()
    const lane = reviewSession('working')
    if (failure === 'crashed') lane.running = false
    if (failure === 'ended') lane.status!.agent!.state = 'ended'
    if (failure === 'stopped') lane.status!.stopped = true
    if (failure === 'relaunched') lane.startedMs = 9999
    useStore.setState({
      serviceConnected: true,
      sessions: { s: reviewSession('review'), ...(failure === 'forgotten' ? {} : { lane }) },
    })
    setRun({
      sessionId: 's',
      turnSince: 1000,
      laneSessions: [{ sessionId: 'lane', startedMs: 1000 }],
    })
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')?.status).toBe('paused')
      expect(autoRun('p', 't')?.reason).toContain('Reviewer lane')
      expect(autoRun('p', 't')?.reason).not.toContain('verdict')
    })
  },
)

test.each(['review', 'implement'] as const)(
  'a completed Auto review waits for another reviewer or follows manual implementation',
  async (stage) => {
    load()
    useStore.setState({
      sessions: { s: reviewSession('review') },
      sessionRecords: [
        {
          id: 'manual',
          metadata: {
            projectId: 'p',
            componentId: stage === 'review' ? '@review' : TASK_ROOT_SCOPE,
            kind: 'agent',
            task: 't',
          },
          spec: { cwd: tree.path },
          snapshot: reviewSession('working'),
        },
      ] as SessionRecord[],
    })
    vi.mocked(ipc.reviewRead).mockResolvedValue(findings())
    setRun({ sessionId: 's', turnSince: 1000 })
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')).toMatchObject({
        stage,
        sessionId: stage === 'review' ? 's' : 'manual',
        reason:
          stage === 'review'
            ? 'Waiting for another agent in this worktree to finish'
            : 'Waiting for the current agent',
      })
      expect(ipc.terminalStop).not.toHaveBeenCalledWith('manual')
      useStore.setState({
        sessions: { ...useStore.getState().sessions, manual: reviewSession('review', 1500) },
      })
      await flush()
      expect(autoRun('p', 't')?.stage).toBe(stage === 'review' ? 'mergeGate' : 'review')
    })
  },
)

test('Resume keeps the original primary while a second reviewer needs input', async () => {
  load()
  const sessions = { s: reviewSession('review'), lane: reviewSession('needsInput') }
  useStore.setState({
    sessions,
    sessionRecords: Object.entries(sessions).map(([id, snapshot]) => ({
      id,
      snapshot,
      metadata: { projectId: 'p', componentId: '@review', kind: 'agent' },
      spec: { cwd: tree.path },
    })) as SessionRecord[],
  })
  setRun({
    status: 'paused',
    sessionId: 's',
    turnSince: 1000,
    laneSessions: [{ sessionId: 'lane', startedMs: 1000 }],
  })
  await resumeAuto('p', 't')
  expect(autoRun('p', 't')).toMatchObject({ sessionId: 's', stage: 'review' })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      status: 'waitingOnYou',
      sessionId: 's',
      inputSessionId: 'lane',
    })
  })
})

test('Resume keeps completed reviewers while checking changed work', async () => {
  load()
  useStore.setState({ sessions: { s: reviewSession('review'), lane: reviewSession('review') } })
  setRun({
    status: 'paused',
    effort: 'light',
    sessionId: 's',
    sessionOwned: true,
    sessionStartedMs: 1000,
    laneSessions: [{ sessionId: 'lane', startedMs: 1000 }],
  })
  await resumeAuto('p', 't')
  expect(autoRun('p', 't')).toMatchObject({
    stage: 'review',
    status: 'running',
    sessionId: 's',
    laneSessions: [{ sessionId: 'lane', startedMs: 1000 }],
  })
  expect(ipc.terminalStop).not.toHaveBeenCalled()
})

test.each(['stop', 'skip', 'finish'] as const)(
  '%s cleans up a reviewer whose launch time came from the service snapshot',
  async (action) => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    load()
    const codex = useStore.getState().devices[0]
    useStore.setState({ devices: [codex, { ...codex, id: 'claude' }] })
    vi.mocked(jobs.startReviewAgent).mockImplementation(async (_p, request) => {
      useStore.setState({ sessions: { s: reviewSession('working'), lane: { running: true } } })
      return request.lane === 'claude' ? 'lane' : 's'
    })
    vi.mocked(ipc.terminalSnapshot).mockResolvedValue({ startedMs: 1000, running: true } as never)
    await withFollower(async () => {
      await startAuto('p', 't', {
        ...run(),
        effort: 'light',
        reviewers: ['codex', 'claude'],
      })
      await flush()
      expect(ipc.terminalSnapshot).toHaveBeenCalledWith('lane')
      expect(autoRun('p', 't')?.laneSessions).toMatchObject([
        { sessionId: 'lane', startedMs: 1000 },
      ])
      useStore.setState({
        sessions: { s: reviewSession('review', 1300), lane: reviewSession('review', 1300) },
      })
      vi.mocked(ipc.reviewRead).mockResolvedValue(findings())
      if (action === 'stop') stopAuto('p', 't')
      else if (action === 'skip') {
        pauseAuto('p', 't')
        await skipStage('p', 't')
      }
      await flush()
      expect(ipc.terminalStop).toHaveBeenCalledWith('lane')
    })
  },
)

test('needs input resumes only on authoritative work; interruption pauses', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  setRun({ sessionId: 's', turnSince: 1000 })
  await withFollower(async () => {
    agent('needsInput', 1100)
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ status: 'waitingOnYou', waitingFor: 'agentInput' })
    useStore.getState().patchTask('p', 't', {
      auto: { ...autoRun('p', 't')!, reason: 'Please answer the question' },
    })
    agent('working', 1200, false)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('waitingOnYou')
    agent('working', 1300)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('running')
    agent('idle', 1400)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('paused')
  })
})
test('inactive worktrees pause and manual changes are picked up on resume', async () => {
  vi.useFakeTimers()
  load()
  setRun({ effort: 'light' })
  useStore.getState().setActiveTask(null, true)
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')?.status).toBe('paused')
    expect(useStore.getState().auto).toBeNull()
    expect(jobs.startReviewAgent).not.toHaveBeenCalled()
    pauseAuto('p', 't')
    vi.mocked(ipc.reviewRead).mockResolvedValue(findings({ high: 1 }))
    useStore.getState().setActiveTask('t')
    await resumeAuto('p', 't')
    expect(autoRun('p', 't')?.stage).toBe('fix')
  })
})
test('skipping review still requires explicit merge approval', () => {
  load()
  setRun({ status: 'paused', merge: { mode: 'auto', destinationBranch: 'main' } })
  skipStage('p', 't')
  expect(autoRun('p', 't')).toMatchObject({ stage: 'mergeGate', status: 'waitingOnYou' })
})

test.each([false, true])(
  'a task description launches Plan and hands off its saved plan (Simple: %s)',
  async (simpleMode) => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    load()
    useStore.setState({ simpleMode })
    vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
    const { startTerminal } = await import('./sessions')
    const { implementPlannerPlan } = await import('./planHandoff')
    vi.mocked(startTerminal).mockImplementation(async () => {
      const { plannerSessionId } = await import('../types')
      const sid = plannerSessionId('codex', 'p')
      useStore.setState({ sessions: { [sid]: { running: true, startedMs: 1000 } } })
    })
    vi.mocked(implementPlannerPlan).mockResolvedValue({
      sessionId: 'implementation',
      requestId: 'r',
    })
    await withFollower(async () => {
      await startAuto('p', 't', {
        goal: 'Implement the description',
        effort: 'standard',
        device: 'codex',
        merge: { mode: 'ask', destinationBranch: 'main' },
      })
      await flush()
      expect(startTerminal).toHaveBeenCalledWith('@plan', 'codex', 't', 'p', {
        kickoff: { kind: 'plan' },
        auto: expect.objectContaining({ goal: 'Implement the description', commit: false }),
      })
      const sid = autoRun('p', 't')!.sessionId!
      vi.mocked(ipc.planRead).mockResolvedValue({ text: '# Saved description plan', cut: false })
      useStore.setState({
        sessions: {
          [sid]: {
            running: true,
            startedMs: 1000,
            status: {
              stopped: false,
              agent: { state: 'review', sinceMs: 1200, authoritative: true },
            },
          } as SessionState,
        },
      })
      await flush()
      await vi.advanceTimersByTimeAsync(5000)
      await flush()
      expect(implementPlannerPlan).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ goal: 'Implement the description', commit: true }),
        'codex',
        simpleMode ? 'stay' : 'follow',
        { projectId: 'p', task: 't' },
      )
    })
  },
)

test('validation uses the pinned worktree and keeps failed results when the user switches tasks', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  useStore.getState().addComponent({ x: 0, y: 0 })
  const id = useStore.getState().selectedId!
  vi.mocked(ipc.gitReview).mockResolvedValue({
    ahead: true,
    changes: { [id]: [{ path: 'file.txt', kind: 'modified' }] },
    affected: [],
  })
  const report = {
    plan: {
      request: { kind: 'validateAffected' as const, componentId: id },
      sessions: ['check'],
      stages: [],
      skipped: [],
      task: 't',
    },
    results: [{ sessionId: 'check', outcome: 'failed' as const, exitCode: 1 }],
  }
  vi.mocked(ipc.graphActionRun).mockImplementation(async () => {
    useStore.getState().setActiveTask(null, true)
    return report
  })
  await withFollower(async () => {
    await startAuto('p', 't', {
      goal: 'Goal',
      effort: 'standard',
      device: 'codex',
      merge: { mode: 'ask', destinationBranch: 'main' },
    })
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    await flush()
    expect(ipc.graphActionRun).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p' }),
      { kind: 'validateChanged', componentIds: [id] },
      't',
    )
    expect(autoRun('p', 't')).toMatchObject({
      status: 'paused',
      stage: 'review',
      validation: [report],
    })
    expect(autoRun('p', 't')?.validationFindings).toContain('[high] Validation failed')
    expect(useStore.getState().taskWorkspaces.t.graphActionReport).toEqual(report)
    expect(jobs.startReviewAgent).not.toHaveBeenCalled()
  })
})

test('snapshot includes component agents below the worktree root and ignores exited working reports', async () => {
  load()
  useStore.getState().addComponent({ x: 0, y: 0 })
  const id = useStore.getState().selectedId!
  useStore.setState({
    sessionRecords: [
      {
        id: 'component-agent',
        metadata: { projectId: 'p', task: 't', componentId: id, kind: 'agent' },
        spec: { cwd: '/p/feature/subdirectory' },
        snapshot: null,
      },
    ] as unknown as import('../types').SessionRecord[],
  })
  useStore.setState({
    sessions: {
      'component-agent': {
        running: true,
        status: { agent: { state: 'working', sinceMs: 10, authoritative: true } },
      } as SessionState,
    },
  })
  const { autoSnapshot } = await import('./auto')
  expect(inferStage(await autoSnapshot('p', 't', run()), run())).toMatchObject({
    stage: 'implement',
    sessionId: 'component-agent',
  })
  useStore.setState({
    sessions: {
      'component-agent': {
        running: false,
        status: { agent: { state: 'working', sinceMs: 10, authoritative: true } },
      } as SessionState,
    },
  })
  expect((await autoSnapshot('p', 't', run())).agents).toEqual([])
})

test('skipping a paused active step stops its tracked agent before the next handoff', async () => {
  load()
  agent('working', 1000)
  setRun({ status: 'paused', stage: 'fix', sessionId: 's', sessionOwned: true })
  // Without the launch's start time it isn't provably Auto's, so it keeps running.
  await skipStage('p', 't')
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  setRun({
    status: 'paused',
    stage: 'fix',
    sessionId: 's',
    sessionOwned: true,
    sessionStartedMs: 1000,
  })
  await skipStage('p', 't')
  expect(ipc.terminalStop).toHaveBeenCalledWith('s')
  expect(autoRun('p', 't')).toMatchObject({
    stage: 'review',
    status: 'running',
    sessionId: undefined,
  })
})

test('provider startup idle waits for working, and unconfirmed interruption then pauses', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  setRun({ sessionId: 's', turnSince: 1000 })
  await withFollower(async () => {
    agent('idle', 1100)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('running')
    agent('working', 1200)
    await flush()
    agent('idle', 1300, false)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('paused')
  })
})

test('denying an agent prompt pauses even when no provider hook confirms the denial', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  setRun({ sessionId: 's', turnSince: 1000 })
  await withFollower(async () => {
    agent('needsInput', 1100)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('waitingOnYou')
    agent('idle', 1200, false)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('paused')
  })
})

test('service-side forgetting pauses the run instead of waiting forever for a removed session', async () => {
  vi.useFakeTimers()
  load()
  useStore.setState({ serviceConnected: true, sessionRecords: [], sessions: {} })
  setRun({ sessionId: 'forgotten' })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      status: 'paused',
      reason: 'The tracked session was forgotten',
    })
  })
})

test('validation findings name failed terminals, not whole reports', () => {
  const report = {
    plan: {
      request: { kind: 'validateAffected' as const, componentId: 'a' },
      stages: [],
      skipped: ['b'],
      sessions: [],
      task: null,
    },
    results: [
      { sessionId: 'ok', outcome: 'passed' as const, exitCode: 0 },
      { sessionId: 'bad', outcome: 'failed' as const, exitCode: 2 },
    ],
  }
  expect(validationFailures([report], (id) => `Test ${id}`)).toBe(
    '[high] Validation failed: Test bad failed (exit 2)',
  )
})

test('starting at Merge on an unreviewed branch waits for approval', async () => {
  load()
  await startAuto('p', 't', {
    goal: 'Goal',
    effort: 'light',
    merge: { mode: 'auto', destinationBranch: 'main' },
    device: 'codex',
    stage: 'merge',
  })
  expect(autoRun('p', 't')).toMatchObject({ stage: 'mergeGate', reviewedHead: undefined })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ stage: 'mergeGate', status: 'waitingOnYou' })
    expect(jobs.startMergeAgent).not.toHaveBeenCalled()
  })
})

test('the project-wide planner belongs to a run only while it plans or tracks it', async () => {
  load()
  const planner = {
    id: 'planner',
    metadata: { projectId: 'p', componentId: '@plan', kind: 'agent' },
    spec: { cwd: '/p', command: 'codex' },
  } as unknown as import('../types').SessionRecord
  useStore.setState({
    sessionRecords: [planner],
    sessions: {
      planner: {
        running: true,
        status: { agent: { state: 'working', sinceMs: 1, authoritative: true } },
      } as SessionState,
    },
  })
  expect((await autoSnapshot('p', 't', run({ stage: 'implement' }))).agents).toEqual([])
  expect((await autoSnapshot('p', 't', run({ stage: 'plan' }))).agents).toHaveLength(1)
  expect(
    (await autoSnapshot('p', 't', run({ stage: 'review', sessionId: 'planner' }))).agents,
  ).toHaveLength(1)
})

test('the project folder resolves to the current worktree and reviews against the destination', async () => {
  load()
  useStore.getState().setActiveTask(null, true)
  vi.mocked(ipc.gitWorktrees).mockResolvedValue([
    tree,
    { ...tree, path: '/repo', branch: 'work', current: true },
    { ...tree, path: '/repo-release', branch: 'release' },
  ])
  vi.mocked(ipc.gitBranches).mockResolvedValue(['main', 'work', 'release'])
  const snap = await autoSnapshot(
    'p',
    null,
    run({ merge: { mode: 'ask', destinationBranch: 'release' } }),
  )
  expect(snap.source.path).toBe('/repo')
  expect(snap.base).toBe('release')
  expect(ipc.gitReview).toHaveBeenCalledWith(expect.anything(), '/repo', 'release')
})

test('stopping Auto cancels only a validation it started', () => {
  load()
  setRun({ stage: 'validate', status: 'paused' })
  stopAuto('p', 't')
  expect(ipc.graphValidationCancel).not.toHaveBeenCalled()
  expect(autoRun('p', 't')?.status).toBe('stopped')
})

test('clean verdicts with nits use the configured severity floor', () => {
  const cleanWithNits = findings({ low: 1 })
  cleanWithNits.verdict!.clean = true
  expect(nextStep(run(), cleanWithNits)).toMatchObject({ stage: 'mergeGate', status: 'running' })
  expect(nextStep(run({ effort: 'thorough' }), cleanWithNits).stage).toBe('fix')
})

test('findings against a different base cannot authorize automatic merging', async () => {
  load()
  vi.mocked(ipc.reviewRead).mockResolvedValue({ ...findings(), base: 'develop' })
  const snap = await autoSnapshot('p', 't', run())
  expect(snap.freshness).toBe('stale')
  await startAuto('p', 't', {
    goal: 'Goal',
    effort: 'light',
    device: 'codex',
    merge: { mode: 'auto', destinationBranch: 'main' },
  })
  expect(autoRun('p', 't')).toMatchObject({ stage: 'review', reviewedHead: undefined })
})

test('skipping a stale review clears the old head and permits an approved merge', async () => {
  load()
  setRun({ status: 'paused', reviewedHead: 'before-fix' })
  await skipStage('p', 't')
  expect(autoRun('p', 't')).toMatchObject({ stage: 'mergeGate', reviewedHead: undefined })
  await withFollower(async () => {
    mergeNow('p', 't')
    await flush()
    expect(jobs.startMergeAgent).toHaveBeenCalledTimes(1)
    expect(autoRun('p', 't')?.status).toBe('running')
  })
})

function manualAgent() {
  agent('working', 1000)
  useStore.setState({
    sessionRecords: [
      {
        id: 's',
        metadata: { ...plannerRecord().metadata, task: 't', componentId: '@task' },
        spec: { cwd: tree.path },
        snapshot: null,
      },
    ] as unknown as import('../types').SessionRecord[],
  })
}

test.each(['start', 'resume'] as const)(
  '%s observes a manual agent without stopping it on completion or Stop Auto',
  async (how) => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    load()
    manualAgent()
    if (how === 'start')
      await startAuto('p', 't', {
        goal: 'Goal',
        effort: 'light',
        device: 'codex',
        merge: { mode: 'ask', destinationBranch: 'main' },
      })
    else {
      setRun({ effort: 'light', status: 'paused' })
      await resumeAuto('p', 't')
    }
    expect(autoRun('p', 't')?.sessionId).toBe('s')
    stopAuto('p', 't')
    expect(ipc.terminalStop).not.toHaveBeenCalled()
    await resumeAuto('p', 't')
    await withFollower(async () => {
      agent('review', 1200)
      await flush()
      expect(jobs.startReviewAgent).toHaveBeenCalledTimes(1)
      expect(ipc.terminalStop).not.toHaveBeenCalled()
    })
  },
)

test('skipping an adopted agent and stopping a manually relaunched generation leave it running', async () => {
  load()
  manualAgent()
  useStore
    .getState()
    .patchTask('p', 't', { auto: run({ status: 'paused', sessionId: 's', sessionOwned: false }) })
  await skipStage('p', 't')
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  setRun({ sessionId: 's', sessionOwned: true, sessionStartedMs: 900 })
  stopAuto('p', 't')
  expect(ipc.terminalStop).not.toHaveBeenCalled()
})

test('resuming preserves ownership only for the same Auto-launched generation', async () => {
  load()
  manualAgent()
  setRun({ status: 'paused', sessionId: 's', sessionOwned: true, sessionStartedMs: 1000 })
  await resumeAuto('p', 't')
  expect(autoRun('p', 't')?.sessionOwned).toBe(true)
  stopAuto('p', 't')
  expect(ipc.terminalStop).toHaveBeenCalledWith('s')
})

test('terminal output cannot cause repeated Git snapshots while findings are pending', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  agent('review', 1100)
  setRun({ sessionId: 's', sessionOwned: true, turnSince: 1000, launchAtMs: 1000 })
  await withFollower(async () => {
    await flush()
    const snapshots = vi.mocked(ipc.gitWorktrees).mock.calls.length
    expect(snapshots).toBe(1)
    for (let i = 0; i < 20; i++) {
      useStore.setState({
        sessions: { ...useStore.getState().sessions, noisy: { running: true, startedMs: i } },
      })
      await flush()
    }
    expect(ipc.gitWorktrees).toHaveBeenCalledTimes(snapshots)
    vi.mocked(ipc.reviewRead).mockResolvedValue(findings())
    await vi.advanceTimersByTimeAsync(5000)
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ stage: 'mergeGate', status: 'waitingOnYou' })
  })
})

test('all changed components are sent in one validation request', async () => {
  load()
  useStore.getState().addComponent({ x: 0, y: 0 })
  const a = useStore.getState().selectedId!
  useStore.getState().addComponent({ x: 100, y: 0 })
  const b = useStore.getState().selectedId!
  vi.mocked(ipc.gitReview).mockResolvedValue({
    ahead: true,
    changes: {
      [a]: [{ path: 'a', kind: 'modified' }],
      [b]: [{ path: 'b', kind: 'modified' }],
    },
    affected: [],
  })
  vi.mocked(ipc.graphActionRun).mockResolvedValue({
    plan: { stages: [], skipped: [], sessions: [] },
    results: [],
  } as unknown as import('../types').ActionReport)
  await withFollower(async () => {
    await startAuto('p', 't', {
      goal: 'Goal',
      effort: 'standard',
      device: 'codex',
      merge: { mode: 'ask', destinationBranch: 'main' },
    })
    await flush()
    expect(ipc.graphActionRun).toHaveBeenCalledTimes(1)
    expect(ipc.graphActionRun).toHaveBeenCalledWith(
      expect.anything(),
      { kind: 'validateChanged', componentIds: [a, b] },
      't',
    )
  })
})

test('a new goal plans before implementing an unrelated saved plan or proposal', async () => {
  load()
  vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
  vi.mocked(ipc.planRead).mockResolvedValue({ text: '# Unrelated old goal', cut: false })
  vi.mocked(ipc.proposalRead).mockResolvedValue({ version: 1, plan: 'Old goal', assignments: [] })
  await startAuto('p', 't', {
    goal: 'New task',
    effort: 'light',
    device: 'codex',
    merge: { mode: 'ask', destinationBranch: 'main' },
  })
  expect(autoRun('p', 't')).toMatchObject({ stage: 'plan', goal: 'New task' })
  expect(inferStage(snapshot({ plan: '# Accepted plan' }), run({ stage: 'implement' })).stage).toBe(
    'implement',
  )
})

test("a new task's goal is its own, never the project's leftover plan", async () => {
  load()
  vi.mocked(ipc.planRead).mockImplementation(async (_projectId, task) => ({
    text: task ? '' : '# Unrelated old goal',
    cut: false,
  }))
  expect((await autoSnapshot('p', 't', run())).goal).toBe('Task')
  vi.mocked(ipc.planRead).mockImplementation(async (_projectId, task) => ({
    text: task ? '# Task plan' : '# Unrelated old goal',
    cut: false,
  }))
  expect((await autoSnapshot('p', 't', run())).goal).toBe('Task plan')
})

test('the default branch in the project folder asks for a worktree', async () => {
  const { NoReviewBase, wantsNewWorktree } = await import('./auto')
  load()
  vi.mocked(ipc.gitBranches).mockResolvedValue(['main'])
  vi.mocked(ipc.gitWorktrees).mockResolvedValue([
    { ...tree, path: '/p', branch: 'main', current: true },
  ])
  // Runs keep the message; only the dialog offers a new worktree for it.
  const error = await autoSnapshot('p', null, run()).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(NoReviewBase)
  expect(String(error)).toMatch('No review base found; choose another worktree')
  expect(wantsNewWorktree(error as InstanceType<typeof NoReviewBase>)).toBe(true)
})

test('a branch that is not the default asks for another worktree, not a new one', async () => {
  const { NoReviewBase, wantsNewWorktree } = await import('./auto')
  load()
  vi.mocked(ipc.gitBranches).mockResolvedValue(['feature', 'develop'])
  vi.mocked(ipc.gitWorktrees).mockResolvedValue([
    { ...tree, path: '/p', branch: 'feature', current: true },
  ])
  const error = await autoSnapshot('p', null, run({ runId: '' })).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(NoReviewBase)
  expect(wantsNewWorktree(error as InstanceType<typeof NoReviewBase>)).toBe(false)
})

test('needsInput can go directly to review without an observed working tick', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  vi.mocked(ipc.reviewRead).mockResolvedValue(findings())
  setRun({ sessionId: 's', turnSince: 1000 })
  await withFollower(async () => {
    agent('needsInput', 1100)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('waitingOnYou')
    agent('review', 1200, false)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('waitingOnYou')
    agent('review', 1200)
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    expect(autoRun('p', 't')).toMatchObject({ stage: 'mergeGate', status: 'waitingOnYou' })
  })
})

function plannerRecord() {
  return {
    id: 's',
    metadata: { projectId: 'p', componentId: '@plan', kind: 'agent' },
    spec: { cwd: '/p', command: 'codex' },
  } as unknown as import('../types').SessionRecord
}

test.each(['running', 'paused', 'waitingOnYou'] as const)(
  'Resume cannot take another restored %s run’s planner before tasks load',
  async (status) => {
    load()
    useStore
      .getState()
      .patchTask('p', 'restored', { auto: run({ stage: 'plan', sessionId: 's', status }) })
    useStore
      .getState()
      .patchTask('p', 't', { auto: run({ runId: 'second', stage: 'plan', status: 'paused' }) })
    useStore.setState({ sessionRecords: [plannerRecord()] })
    agent('working', 1000)
    await resumeAuto('p', 't')
    expect(autoRun('p', 't')?.sessionId).toBeUndefined()
    expect(autoRun('p', 'restored')).toMatchObject({ status, sessionId: 's' })
  },
)

test('Auto stops a planner it took over before handing off the completed plan', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
  useStore.setState({ sessionRecords: [plannerRecord()] })
  agent('working', 1000)
  await startAuto('p', 't', {
    goal: 'New task',
    effort: 'light',
    device: 'codex',
    merge: { mode: 'ask', destinationBranch: 'main' },
  })
  expect(autoRun('p', 't')?.sessionOwned).not.toBe(true)
  vi.mocked(ipc.planRead).mockResolvedValue({ text: '# New plan', cut: false })
  const { implementPlannerPlan } = await import('./planHandoff')
  vi.mocked(implementPlannerPlan).mockResolvedValue({ sessionId: 'implementation', requestId: 'r' })
  agent('review', 1200)
  await withFollower(async () => {
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    expect(ipc.terminalStop).toHaveBeenCalledWith('s')
    expect(implementPlannerPlan).toHaveBeenCalledOnce()
    expect(vi.mocked(ipc.terminalStop).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(implementPlannerPlan).mock.invocationCallOrder[0],
    )
  })
})

test('idle agent processes without a provider report do not count as working forever', async () => {
  load()
  useStore.setState({
    sessionRecords: [
      {
        ...plannerRecord(),
        metadata: { ...plannerRecord().metadata, task: 't', componentId: '@task' },
      },
    ],
  })
  useStore.setState({
    sessions: { s: { running: true, status: { active: false, agent: null } } as SessionState },
  })
  expect((await autoSnapshot('p', 't', run())).agents[0].state).toBe('idle')
  useStore.setState({
    sessions: { s: { running: true, status: { active: true, agent: null } } as SessionState },
  })
  expect((await autoSnapshot('p', 't', run())).agents[0].state).toBe('working')
})

test('snapshot reads the project plan once in the project folder', async () => {
  load()
  useStore.getState().setActiveTask(null, true)
  await autoSnapshot('p', null, run({ merge: { mode: 'ask', destinationBranch: 'feature' } }))
  expect(ipc.planRead).toHaveBeenCalledExactlyOnceWith('p')
})

test.each(['plan', 'implement', 'fix', 'merge'] as const)(
  '%s tracks a confirmed launch without claiming ownership when its start time is unavailable',
  async (stage) => {
    load()
    const { plannerSessionId } = await import('../types')
    const { implementPlannerPlan } = await import('./planHandoff')
    const { fixReviewFindings } = await import('./reviewHandoff')
    const sid = stage === 'plan' ? plannerSessionId('codex', 'p') : 'launched'
    vi.mocked(ipc.terminalSnapshot).mockResolvedValue(null)
    vi.mocked(awaitSessions.reconcileFreshSessions).mockImplementation(async () => {
      useStore.setState({ sessions: { [sid]: { running: true } } })
    })
    vi.mocked(implementPlannerPlan).mockResolvedValue({ sessionId: sid, requestId: 'r' })
    vi.mocked(fixReviewFindings).mockResolvedValue({ sessionId: sid, requestId: 'r' })
    vi.mocked(jobs.startMergeAgent).mockResolvedValue(sid)
    useStore.setState({
      sessionRecords: [
        {
          id: 'reviewer',
          metadata: { projectId: 'p', componentId: '@review' },
          spec: { cwd: tree.path },
        },
      ] as SessionRecord[],
    })
    setRun({ stage })
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')).toMatchObject({
        stage,
        status: 'running',
        sessionId: sid,
        sessionOwned: false,
        round: stage === 'fix' ? 1 : 0,
      })
      expect(ipc.terminalSnapshot).toHaveBeenCalledWith(sid)
      expect(ipc.terminalStop).not.toHaveBeenCalled()
    })
  },
)

test('review launches survive a missing launch snapshot, owned only through their launch request', async () => {
  load()
  vi.mocked(ipc.terminalSnapshot).mockResolvedValue(null)
  vi.mocked(jobs.startReviewAgent).mockResolvedValue('reviewer')
  vi.mocked(awaitSessions.reconcileFreshSessions).mockImplementation(async () => {
    useStore.setState({ sessions: { reviewer: { running: true } } })
  })
  setRun()
  await withFollower(async () => {
    await flush()
    // Owned through its launch request, which no session record lists here.
    expect(autoRun('p', 't')).toMatchObject({
      status: 'running',
      sessionId: 'reviewer',
      sessionStartedMs: undefined,
      sessionRequestId: 'request-reviewer',
    })
    expect(ipc.terminalStop).not.toHaveBeenCalled()
    const startedMs = autoRun('p', 't')!.launchAtMs! + 1
    useStore.setState({ sessions: { reviewer: { running: true, startedMs } } })
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ status: 'running', sessionId: 'reviewer' })
    expect(ipc.terminalStop).not.toHaveBeenCalled()
    vi.mocked(ipc.reviewRead).mockResolvedValue({ ...findings(), startedMs })
    useStore.setState({
      sessions: { reviewer: { ...reviewSession('review', startedMs + 10), startedMs } },
    })
    await flush()
    expect(autoRun('p', 't')?.stage).toBe('mergeGate')
    expect(ipc.terminalStop).not.toHaveBeenCalled()
  })
})

test('Auto refuses an unconfirmed launch without recording a phantom session', async () => {
  load()
  vi.mocked(awaitSessions.reconcileFreshSessions).mockResolvedValue(undefined)
  setRun({ stage: 'merge' })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ status: 'failed', pauseKind: undefined })
    expect(autoRun('p', 't')?.sessionId).toBeUndefined()
    expect(autoRun('p', 't')?.reason).toContain('launch was not confirmed')
  })
})

test('shared planner is reserved while a launch is pending without session records', async () => {
  vi.useFakeTimers()
  load()
  vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
  let finish!: () => void
  vi.mocked(awaitSessions.startTerminal).mockImplementation(
    () =>
      new Promise<undefined>((resolve) => {
        finish = () => resolve(undefined)
      }),
  )
  setRun({ stage: 'plan' })
  const stop = followAuto()
  try {
    await flush()
    expect(awaitSessions.startTerminal).toHaveBeenCalledOnce()
    useStore.getState().setActiveTask(null, true)
    useStore.getState().patchTask('p', null, {
      auto: run({
        runId: 'second',
        stage: 'plan',
        merge: { mode: 'ask', destinationBranch: 'feature' },
      }),
    })
    await flush()
    expect(awaitSessions.startTerminal).toHaveBeenCalledOnce()
    expect(autoRun('p', null)).toMatchObject({
      status: 'running',
      reason: 'Waiting for the planner',
    })
  } finally {
    stopAuto('p', null)
    stopAuto('p', 't')
    finish()
    await flush()
    stop()
  }
})

test('an unfinished merge keeps its agent for the user to answer', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  vi.mocked(ipc.reviewRead).mockResolvedValue(findings())
  vi.mocked(ipc.mergeOutcome).mockResolvedValue('inProgress')
  setRun({ stage: 'merge', sessionId: 's', sessionOwned: true, turnSince: 1000 })
  await withFollower(async () => {
    agent('review', 1100)
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      stage: 'merge',
      status: 'waitingOnYou',
      sessionId: 's',
    })
    expect(ipc.terminalStop).not.toHaveBeenCalled()
  })
})

test('blocking findings never authorize an automatic merge from a chosen stage', async () => {
  load()
  vi.mocked(ipc.reviewRead).mockResolvedValue(findings({ critical: 1 }))
  const settings = {
    goal: 'Goal',
    effort: 'light' as const,
    device: 'codex',
    merge: { mode: 'auto' as const, destinationBranch: 'main' },
  }
  await startAuto('p', 't', { ...settings, stage: 'mergeGate' })
  expect(autoRun('p', 't')).toMatchObject({ stage: 'mergeGate', reviewedHead: undefined })
  expect(nextStep(autoRun('p', 't')!).status).toBe('waitingOnYou')
  stopAuto('p', 't')
  vi.mocked(ipc.reviewRead).mockResolvedValue(findings({ low: 1 }))
  await startAuto('p', 't', { ...settings, stage: 'mergeGate' })
  expect(autoRun('p', 't')?.reviewedHead).toBe('abc')
})

test('validation clears its action state and pauses when the backend refuses it', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  useStore.getState().addComponent({ x: 0, y: 0 })
  const id = useStore.getState().selectedId!
  vi.mocked(ipc.gitReview).mockResolvedValue({
    ahead: true,
    changes: { [id]: [{ path: 'file.txt', kind: 'modified' }] },
    affected: [],
  })
  vi.mocked(ipc.graphActionRun).mockRejectedValue(
    new Error('Another graph action is still running'),
  )
  setRun({ stage: 'validate' })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ stage: 'validate', status: 'paused' })
    expect(autoRun('p', 't')?.reason).toContain('Another graph action is still running')
    expect(useStore.getState().graphAction).toBeNull()
    expect(useStore.getState().graphActionBusy).toBe(false)
  })
})

test('skipping a fix whose budget ran out goes to the merge gate', async () => {
  load()
  setRun({ stage: 'fix', status: 'waitingOnYou', waitingFor: 'fixBudget', round: 1 })
  await skipStage('p', 't')
  expect(autoRun('p', 't')).toMatchObject({ stage: 'mergeGate', status: 'waitingOnYou' })
  setRun({ stage: 'fix', status: 'paused', sessionId: 'gone' })
  await skipStage('p', 't')
  expect(autoRun('p', 't')?.stage).toBe('review')
})

test('snapshots read the merge outcome only while merging or inferring', async () => {
  load()
  vi.mocked(ipc.reviewRead).mockResolvedValue(findings())
  await autoSnapshot('p', 't', run({ stage: 'fix' }))
  expect(ipc.mergeOutcome).not.toHaveBeenCalled()
  await autoSnapshot('p', 't', run({ stage: 'merge' }))
  await autoSnapshot('p', 't', run({ stage: 'fix' }), true)
  expect(ipc.mergeOutcome).toHaveBeenCalledTimes(2)
  // A fresh branch is trivially an ancestor of its base; that isn't a finished merge.
  vi.mocked(ipc.reviewRead).mockResolvedValue(null)
  vi.mocked(ipc.mergeOutcome).mockResolvedValue('alreadyIntegrated')
  expect((await autoSnapshot('p', 't', run({ stage: 'plan' }), true)).outcome).toBe('notMerged')
})

test('a planner that ends its turn without a new plan pauses instead of handing off the old one', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
  vi.mocked(ipc.planRead).mockResolvedValue({ text: '# Earlier plan', cut: false })
  const { startTerminal } = await import('./sessions')
  const { implementPlannerPlan } = await import('./planHandoff')
  const { plannerSessionId } = await import('../types')
  const sid = plannerSessionId('codex', 'p')
  vi.mocked(startTerminal).mockImplementation(async () => {
    useStore.setState({ sessions: { [sid]: { running: true, startedMs: 1000 } } })
  })
  await withFollower(async () => {
    await startAuto('p', 't', {
      goal: 'A new goal',
      effort: 'standard',
      device: 'codex',
      merge: { mode: 'ask', destinationBranch: 'main' },
    })
    await flush()
    // Later starts of the planner get the same brief and kickoff, so Restart can resume it.
    expect(autoRun('p', 't')?.sessionBrief).toMatchObject({
      sessionId: sid,
      kickoff: { kind: 'plan' },
      auto: { goal: 'A new goal' },
    })
    useStore.setState({
      sessions: {
        [sid]: {
          running: true,
          startedMs: 1000,
          status: {
            stopped: false,
            agent: { state: 'review', sinceMs: 1200, authoritative: true },
          },
        } as SessionState,
      },
    })
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    await flush()
    expect(implementPlannerPlan).not.toHaveBeenCalled()
    expect(autoRun('p', 't')).toMatchObject({
      stage: 'plan',
      status: 'paused',
      reason: 'Planner finished without saving a new plan',
    })
  })
})

test('a new run on a branch whose earlier work is merged plans; a resumed one is done', () => {
  const merged = snapshot({
    outcome: 'alreadyIntegrated',
    freshness: 'current',
    findings: findings(),
  })
  expect(inferStage(merged, run(), true)).toMatchObject({ stage: 'plan', status: 'running' })
  expect(inferStage(merged, run({ stage: 'merge' }))).toMatchObject({ stage: 'done' })
  // New work since the merge isn't a fresh start.
  expect(inferStage({ ...merged, hasChanges: true }, run(), true)).toMatchObject({ stage: 'done' })
})

test('resuming after a planner answered picks up its new plan, or waits on its next turn', () => {
  const planning = run({ stage: 'plan', sessionId: 'planner', planMark: 'old' })
  const planner = { sessionId: 'planner', stage: 'plan' as const, state: 'review', sinceMs: 1500 }
  expect(
    inferStage(snapshot({ plan: '# New', planMark: 'new', agents: [planner] }), planning),
  ).toMatchObject({ stage: 'implement', status: 'running' })
  expect(
    inferStage(snapshot({ plan: '# Old', planMark: 'old', agents: [planner] }), planning),
  ).toMatchObject({ stage: 'plan', sessionId: 'planner', turnSince: 1500 })
  // A fresh run never reads an older run's mark.
  expect(inferStage(snapshot({ plan: '# New', planMark: 'new' }), planning, true)).toMatchObject({
    stage: 'plan',
  })
})

test('only merged work needs a new goal, and the chosen stage decides', async () => {
  load()
  vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
  vi.mocked(ipc.planRead).mockResolvedValue({ text: '', cut: false })
  vi.mocked(ipc.reviewRead).mockResolvedValue(findings())
  const settings = (stage?: import('../types').AutoStage) => ({
    goal: '',
    effort: 'standard' as const,
    device: 'codex',
    merge: { mode: 'ask' as const, destinationBranch: 'main' },
    stage,
  })
  vi.mocked(ipc.mergeOutcome).mockResolvedValue('dirty')
  await expect(startAuto('p', 't', settings())).resolves.toBeUndefined()
  useStore.getState().patchTask('p', 't', { auto: undefined })
  vi.mocked(ipc.mergeOutcome).mockResolvedValue('alreadyIntegrated')
  await expect(startAuto('p', 't', settings())).rejects.toThrow('describe the new goal')
  await expect(startAuto('p', 't', settings('implement'))).resolves.toBeUndefined()
})

test('a resumed run planning or implementing a new goal on merged work is not done', () => {
  const merged = snapshot({
    outcome: 'alreadyIntegrated',
    freshness: 'current',
    findings: findings(),
  })
  expect(inferStage(merged, run({ stage: 'plan' }))).toMatchObject({ stage: 'plan' })
  expect(inferStage({ ...merged, plan: '# New' }, run({ stage: 'implement' }))).toMatchObject({
    stage: 'implement',
  })
  expect(inferStage(merged, run({ stage: 'review' }))).toMatchObject({ stage: 'done' })
})

test('another agent busy at the same stage is waited for, not tracked instead', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(2000)
  load()
  vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
  vi.mocked(ipc.planRead).mockResolvedValue({ text: '# Plan', cut: false })
  const root = (id: string, state: 'review' | 'working', sinceMs: number) => ({
    id,
    spec: { cwd: tree.path },
    metadata: { projectId: 'p', componentId: TASK_ROOT_SCOPE, kind: 'agent', task: 't' },
    snapshot: { running: true, startedMs: 1000, status: { agent: { state, sinceMs } } },
  })
  useStore.setState({
    sessionRecords: [root('s', 'review', 1500), root('manual', 'working', 1400)] as never,
  })
  agent('review', 1500)
  setRun({
    stage: 'implement',
    sessionId: 's',
    sessionOwned: true,
    sessionStartedMs: 1000,
    turnSince: 1100,
  })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      stage: 'implement',
      status: 'running',
      sessionId: 's',
      reason: 'Waiting for another agent in this worktree to finish',
    })
    expect(ipc.terminalStop).not.toHaveBeenCalled()
  })
})

test('skipping validation drops its failures', async () => {
  load()
  setRun({ status: 'paused', stage: 'validate', validationFindings: '[high] failed' })
  await skipStage('p', 't')
  expect(autoRun('p', 't')).toMatchObject({ stage: 'review', validationFindings: undefined })
})

test.each(['start', 'resume'] as const)(
  '%s waits for a stopped run’s pending launch',
  async (how) => {
    load()
    let finish!: (sid: string) => void
    vi.mocked(jobs.startReviewAgent).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    setRun()
    await withFollower(async () => {
      await flush()
      expect(jobs.startReviewAgent).toHaveBeenCalledOnce()
      stopAuto('p', 't')
      const stopped = autoRun('p', 't')!
      const action = how === 'resume' ? resumeAuto('p', 't') : startAuto('p', 't', stopped)
      await expect(action).rejects.toThrow('still starting an agent')
      expect(autoRun('p', 't')).toBe(stopped)
      agent('working', 1000)
      finish('s')
      await flush()
      expect(ipc.terminalStop).toHaveBeenCalledWith('s')
      expect(autoRun('p', 't')?.status).toBe('stopped')
    })
  },
)

test.each(['stop', 'pause'] as const)(
  '%s cancels Resume while its Git snapshot is pending',
  async (how) => {
    load()
    setRun({ status: 'paused' })
    let finish!: (trees: Worktree[]) => void
    vi.mocked(ipc.gitWorktrees).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = resumeAuto('p', 't')
    await flush()
    if (how === 'pause') pauseAuto('p', 't')
    else stopAuto('p', 't')
    const stopped = autoRun('p', 't')!
    finish([tree, { ...tree, path: '/p', branch: 'main', current: true }])
    await pending
    expect(autoRun('p', 't')).toBe(stopped)
    await withFollower(async () => {
      await flush()
      expect(jobs.startReviewAgent).not.toHaveBeenCalled()
    })
  },
)

test.each(['merged', 'alreadyIntegrated'] as const)(
  'Merge now finishes a branch already %s by hand',
  async (outcome) => {
    load()
    setRun({ stage: 'mergeGate', status: 'waitingOnYou', reviewedHead: 'old-head' })
    // The manual merge can change HEAD and delete the preset, too.
    useStore.setState({ devices: [] })
    vi.mocked(ipc.mergeOutcome).mockResolvedValue(outcome)
    await withFollower(async () => {
      mergeNow('p', 't')
      await flush()
      expect(autoRun('p', 't')).toMatchObject({ stage: 'done', status: 'done' })
      expect(jobs.startMergeAgent).not.toHaveBeenCalled()
    })
  },
)

test.each(['validate', 'mergeGate', 'done'] as const)(
  '%s refuses to start without an agent preset before reading Git',
  async (stage) => {
    load()
    useStore.setState({ devices: [] })
    await expect(startAuto('p', 't', { ...run(), stage })).rejects.toThrow('Choose an agent preset')
    expect(ipc.gitWorktrees).not.toHaveBeenCalled()
    expect(ipc.gitReview).not.toHaveBeenCalled()
    expect(autoRun('p', 't')).toBeNull()
  },
)

test('terminal output and unrelated store changes do not poll Auto; its timer still does', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  setRun({ sessionId: 's', turnSince: 1000 })
  agent('review', 1100)
  await withFollower(async () => {
    await flush()
    expect(ipc.gitReview).toHaveBeenCalledOnce()
    // No saved verdict yet: a repeated completion would otherwise poll again after 5s.
    vi.setSystemTime(7000)
    const session = useStore.getState().sessions.s
    useStore.setState({
      sessions: {
        s: {
          ...session,
          status: { ...session.status!, lastOutputMs: 7000, agent: { ...session.status!.agent! } },
        },
      },
    })
    useStore.getState().setMessage('Unrelated message')
    await flush()
    expect(ipc.gitReview).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5000)
    expect(ipc.gitReview).toHaveBeenCalledTimes(2)
    agent('working', 13000)
    await flush()
    expect(autoRun('p', 't')?.observedWorking).toBe(true)
  })
})

test.each([undefined, 'validate', 'mergeGate', 'review'] as const)(
  'Start at %s checks status integration before Git review',
  async (stage) => {
    load()
    vi.mocked(ipc.agentHooksCheck).mockResolvedValue({
      installed: false,
      disabled: false,
      reporterAvailable: true,
    } as Awaited<ReturnType<typeof ipc.agentHooksCheck>>)
    await expect(startAuto('p', 't', { ...run(), stage })).rejects.toThrow(
      'Install Agent status integration',
    )
    expect(ipc.gitWorktrees).not.toHaveBeenCalled()
    expect(ipc.gitReview).not.toHaveBeenCalled()
    expect(ipc.graphActionRun).not.toHaveBeenCalled()
    expect(jobs.startReviewAgent).not.toHaveBeenCalled()
    expect(autoRun('p', 't')).toBeNull()
  },
)

test('Pause cancels Resume while its integration check is pending', async () => {
  load()
  setRun({ status: 'paused', effort: 'light' })
  let finish!: (hooks: Awaited<ReturnType<typeof ipc.agentHooksCheck>>) => void
  vi.mocked(ipc.agentHooksCheck).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = resumeAuto('p', 't')
  await flush()
  expect(ipc.agentHooksCheck).toHaveBeenCalledOnce()
  pauseAuto('p', 't')
  const paused = autoRun('p', 't')!
  finish({ installed: true, disabled: false, reporterAvailable: true } as never)
  await pending
  expect(autoRun('p', 't')).toBe(paused)
})

test.each(['merged', 'alreadyIntegrated'] as const)(
  'a waiting merge gate notices a branch %s by hand without approval',
  async (outcome) => {
    vi.useFakeTimers()
    load()
    setRun({ stage: 'mergeGate', status: 'waitingOnYou', reviewedHead: 'old-head' })
    useStore.setState({ devices: [] })
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')?.status).toBe('waitingOnYou')
      vi.mocked(ipc.mergeOutcome).mockResolvedValue(outcome)
      await vi.advanceTimersByTimeAsync(5000)
      expect(autoRun('p', 't')).toMatchObject({ stage: 'done', status: 'done' })
      expect(jobs.startMergeAgent).not.toHaveBeenCalled()
    })
  },
)

test.each(['live', 'record'] as const)(
  'another agent finishing in its %s status wakes Auto immediately',
  async (source) => {
    vi.useFakeTimers()
    vi.setSystemTime(2000)
    load()
    const record = {
      ...plannerRecord(),
      id: 'manual',
      metadata: { ...plannerRecord().metadata, componentId: TASK_ROOT_SCOPE, task: 't' },
      snapshot: {
        running: true,
        startedMs: 1000,
        status: { agent: { state: 'working', sinceMs: 1400 } },
      },
    }
    useStore.setState({ sessionRecords: [record] as never })
    agent('review', 1500)
    setRun({ stage: 'implement', sessionId: 's', turnSince: 1100 })
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')?.reason).toContain('Waiting for another agent')
      const finished = {
        running: true,
        startedMs: 1000,
        status: { agent: { state: 'review', sinceMs: 2100 } },
      }
      if (source === 'live')
        useStore.setState({
          sessions: { ...useStore.getState().sessions, manual: finished as SessionState },
        })
      else useStore.setState({ sessionRecords: [{ ...record, snapshot: finished }] as never })
      await flush()
      expect(autoRun('p', 't')?.stage).not.toBe('implement')
    })
  },
)

test('a session update received during a Git snapshot is retried as soon as it finishes', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(2000)
  load()
  agent('review', 1500)
  setRun({ sessionId: 's', turnSince: 1100 })
  let finish!: (trees: Worktree[]) => void
  vi.mocked(ipc.gitWorktrees).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await withFollower(async () => {
    await flush()
    agent('working', 2100)
    await flush()
    finish([tree, { ...tree, path: '/p', branch: 'main', current: true }])
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ observedWorking: true, turnSince: 2100 })
  })
})

test.each(['review', 'fix'] as const)(
  'Pause during a %s launch keeps its agent attached and accounts for the round',
  async (stage) => {
    load()
    const { fixReviewFindings } = await import('./reviewHandoff')
    const { REVIEW_SCOPE } = await import('../types')
    if (stage === 'fix')
      useStore.setState({
        sessionRecords: [
          {
            id: 'reviewer',
            metadata: { projectId: 'p', componentId: REVIEW_SCOPE },
            spec: { cwd: tree.path },
          },
        ] as never,
      })
    let finish!: (sid: string) => void
    const pending = () =>
      new Promise<string>((resolve) => {
        finish = resolve
      })
    const launch = stage === 'fix' ? fixReviewFindings : jobs.startReviewAgent
    if (stage === 'fix')
      vi.mocked(fixReviewFindings).mockImplementation(() =>
        pending().then((sessionId) => ({ sessionId, requestId: undefined })),
      )
    else vi.mocked(jobs.startReviewAgent).mockImplementation(pending)
    setRun({ stage })
    await withFollower(async () => {
      await flush()
      expect(launch).toHaveBeenCalledOnce()
      pauseAuto('p', 't')
      expect(autoRun('p', 't')?.runId).toBe('run')
      await expect(resumeAuto('p', 't')).rejects.toThrow('still starting an agent')
      agent('working', 1000)
      useStore.setState({
        sessionRecords: [
          ...useStore.getState().sessionRecords,
          {
            id: 's',
            metadata: {
              projectId: 'p',
              componentId: stage === 'fix' ? TASK_ROOT_SCOPE : REVIEW_SCOPE,
              kind: 'agent',
              task: 't',
            },
            spec: { cwd: tree.path },
          },
        ] as never,
      })
      finish('s')
      await flush()
      expect(autoRun('p', 't')).toMatchObject({
        runId: 'run',
        status: 'paused',
        sessionId: 's',
        sessionOwned: true,
        round: stage === 'fix' ? 1 : 0,
      })
      expect(ipc.terminalStop).not.toHaveBeenCalled()
      await resumeAuto('p', 't')
      expect(autoRun('p', 't')).toMatchObject({ status: 'running', sessionId: 's' })
      expect(launch).toHaveBeenCalledOnce()
    })
  },
)

test('merge-gate polls are throttled and read only the outcome after resolving worktrees', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  setRun({ stage: 'mergeGate', status: 'waitingOnYou' })
  await withFollower(async () => {
    await flush()
    expect(ipc.gitWorktrees).toHaveBeenCalledOnce()
    expect(ipc.mergeOutcome).toHaveBeenCalledOnce()
    for (let i = 0; i < 5; i++) {
      agent('working', 1001 + i)
      useStore.getState().patchTask('p', 't', {
        auto: { ...autoRun('p', 't')!, reason: `Still waiting ${i}` },
      })
      await flush()
    }
    expect(ipc.gitWorktrees).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5000)
    expect(ipc.gitWorktrees).toHaveBeenCalledOnce()
    expect(ipc.mergeOutcome).toHaveBeenCalledTimes(2)
    expect(ipc.gitBranches).not.toHaveBeenCalled()
    expect(ipc.gitReview).not.toHaveBeenCalled()
    expect(ipc.reviewRead).not.toHaveBeenCalled()
    expect(ipc.planRead).not.toHaveBeenCalled()
    expect(ipc.proposalRead).not.toHaveBeenCalled()
  })
})

test('Resume can infer the stage while a merge-gate poll is pending', async () => {
  load()
  vi.mocked(ipc.reviewRead).mockResolvedValue(findings())
  setRun({ stage: 'mergeGate', status: 'waitingOnYou' })
  let finish!: (trees: Worktree[]) => void
  vi.mocked(ipc.gitWorktrees).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await withFollower(async () => {
    await flush()
    await expect(resumeAuto('p', 't')).resolves.toBeUndefined()
    expect(autoRun('p', 't')?.runId).not.toBe('run')
    finish([tree, { ...tree, path: '/p', branch: 'main', current: true }])
    await flush()
    expect(autoRun('p', 't')?.status).toBe('waitingOnYou')
  })
})

test.each(['worktrees', 'outcome'] as const)(
  'merge-gate %s failures keep approval pending and retry automatically',
  async (failure) => {
    vi.useFakeTimers()
    load()
    setRun({ stage: 'mergeGate', status: 'waitingOnYou', reason: 'Approval required' })
    if (failure === 'worktrees')
      vi.mocked(ipc.gitWorktrees).mockRejectedValueOnce(new Error('Branch switched'))
    else vi.mocked(ipc.mergeOutcome).mockRejectedValueOnce(new Error('Git lock'))
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')).toMatchObject({
        status: 'waitingOnYou',
        reason: 'Approval required',
        gateError: expect.stringContaining(
          failure === 'worktrees' ? 'Branch switched' : 'Git lock',
        ),
      })
      expect(autoRun('p', 't')?.log).toHaveLength(1)
      vi.mocked(ipc.mergeOutcome).mockResolvedValue('merged')
      await vi.advanceTimersByTimeAsync(5000)
      expect(autoRun('p', 't')).toMatchObject({ stage: 'done', status: 'done' })
      expect(jobs.startMergeAgent).not.toHaveBeenCalled()
    })
  },
)

test.each(['skip', 'resume', 'completion'] as const)(
  'leaving a fix via %s keeps validation failures until a validation runs',
  async (transition) => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    load()
    setRun({
      stage: 'fix',
      status: transition === 'completion' ? 'running' : 'paused',
      effort: 'light',
      validationFindings: '[high] Previous validation failed',
      sessionId: transition === 'completion' ? 's' : undefined,
      turnSince: 1000,
    })
    if (transition === 'skip') await skipStage('p', 't')
    else if (transition === 'resume') await resumeAuto('p', 't')
    else {
      agent('review', 1100)
      vi.mocked(jobs.startReviewAgent).mockImplementation(async () => {
        agent('working', 1200)
        return 's'
      })
      await withFollower(async () => {
        await flush()
      })
    }
    const current = autoRun('p', 't')!
    if (transition === 'completion') {
      // Light effort skips validation, but a finished fix still re-validates the failures (here
      // with nothing to check, which passes).
      expect(current).toMatchObject({ stage: 'review', validationFindings: undefined })
      expect(current.log.map((l) => l.text)).toContain('Validation passed')
      expect(nextStep(current, findings()).stage).toBe('mergeGate')
      return
    }
    // A clean review can't merge past failures a skipped or interrupted fix left, and resuming
    // the changed branch validates it again first.
    expect(current).toMatchObject({
      stage: transition === 'resume' ? 'validate' : 'review',
      validationFindings: '[high] Previous validation failed',
    })
    expect(nextStep({ ...current, stage: 'review' }, findings()).stage).toBe('fix')
    expect(reviewDecision(current, findings()).stage).toBe('fix')
    expect(
      mergeableHead(snapshot({ freshness: 'current', findings: findings() }), current),
    ).toBeUndefined()
  },
)

test('approval polling refreshes its request after a changed destination worktree', async () => {
  vi.useFakeTimers()
  load()
  setRun({ stage: 'mergeGate', status: 'waitingOnYou', branch: 'feature' })
  const destination = { ...tree, path: '/p', branch: 'main', current: true }
  await withFollower(async () => {
    await flush()
    expect(ipc.gitWorktrees).toHaveBeenCalledOnce()
    vi.mocked(ipc.mergeOutcome).mockRejectedValueOnce(new Error('destination changed'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(autoRun('p', 't')?.gateError).toContain('destination changed')
    vi.mocked(ipc.gitWorktrees).mockResolvedValue([tree])
    await vi.advanceTimersByTimeAsync(5000)
    expect(autoRun('p', 't')?.gateError).toContain('existing worktree')
    const moved = { ...destination, path: '/p/main' }
    vi.mocked(ipc.gitWorktrees).mockResolvedValue([tree, moved])
    vi.mocked(ipc.mergeOutcome).mockImplementation(async (_project, request) =>
      request.destination === moved.path ? 'merged' : Promise.reject('Stale destination'),
    )
    await vi.advanceTimersByTimeAsync(5000)
    expect(ipc.gitWorktrees).toHaveBeenCalledTimes(3)
    expect(autoRun('p', 't')).toMatchObject({ stage: 'done', status: 'done' })
    expect(jobs.startMergeAgent).not.toHaveBeenCalled()
  })
})

test("approval polling never judges another branch checked out in the run's worktree", async () => {
  vi.useFakeTimers()
  load()
  setRun({ stage: 'mergeGate', status: 'waitingOnYou', branch: 'feature' })
  const destination = { ...tree, path: '/p', branch: 'main', current: true }
  await withFollower(async () => {
    await flush()
    // The user checks out another branch, which is already merged, in the run's worktree.
    vi.mocked(ipc.mergeOutcome).mockRejectedValueOnce(new Error('The merge branches changed'))
    vi.mocked(ipc.gitWorktrees).mockResolvedValue([{ ...tree, branch: 'hotfix' }, destination])
    vi.mocked(ipc.mergeOutcome).mockResolvedValue('merged')
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(autoRun('p', 't')).toMatchObject({
      stage: 'mergeGate',
      status: 'waitingOnYou',
      gateError: expect.stringContaining('hotfix checked out'),
    })
    expect(ipc.mergeOutcome).toHaveBeenCalledTimes(2)
    expect(
      vi.mocked(ipc.mergeOutcome).mock.calls.every(([, r]) => r.sourceBranch === 'feature'),
    ).toBe(true)
    // Checking the run's branch out again lets the poll judge it.
    vi.mocked(ipc.gitWorktrees).mockResolvedValue([tree, destination])
    await vi.advanceTimersByTimeAsync(5000)
    expect(autoRun('p', 't')).toMatchObject({ stage: 'done', status: 'done' })
  })
})

test('a running run pauses when its worktree has another branch checked out', async () => {
  load()
  setRun({ stage: 'review', branch: 'other' })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ status: 'paused', stage: 'review' })
    expect(autoRun('p', 't')?.reason).toContain("this run's other")
    expect(jobs.startReviewAgent).not.toHaveBeenCalled()
  })
})

test("a recovered approval poll clears its error and keeps the wait's reason", async () => {
  vi.useFakeTimers()
  load()
  setRun({ stage: 'mergeGate', status: 'waitingOnYou', reason: 'Stage skipped by you' })
  vi.mocked(ipc.mergeOutcome)
    .mockRejectedValueOnce(new Error('Temporary Git lock'))
    .mockRejectedValueOnce(new Error('Another Git lock'))
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      reason: 'Stage skipped by you',
      gateError: 'Temporary Git lock',
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect(autoRun('p', 't')?.gateError).toBe('Another Git lock')
    await vi.advanceTimersByTimeAsync(5000)
    expect(autoRun('p', 't')).toMatchObject({
      status: 'waitingOnYou',
      reason: 'Stage skipped by you',
      gateError: undefined,
    })
  })
})

test.each(['stopped', 'exited', 'idle'] as const)(
  'a running merge agent that %s finishes Done when Git shows the merge',
  async (end) => {
    load()
    agent(end === 'idle' ? 'idle' : 'working', 1100)
    setRun({
      stage: 'merge',
      sessionId: 's',
      sessionOwned: true,
      turnSince: 1000,
      observedWorking: true,
      sessionStartedMs: 1000,
    })
    const s = useStore.getState().sessions.s
    useStore.setState({
      sessions: {
        s:
          end === 'stopped'
            ? { ...s, status: { ...s.status!, stopped: true } }
            : end === 'exited'
              ? { ...s, running: false }
              : s,
      },
    })
    vi.mocked(ipc.mergeOutcome).mockResolvedValue('merged')
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')).toMatchObject({ stage: 'done', status: 'done' })
      // An owned agent idle at its prompt is stopped with the run; an ended one needs no stop.
      if (end === 'idle') expect(ipc.terminalStop).toHaveBeenCalledWith('s')
      else expect(ipc.terminalStop).not.toHaveBeenCalled()
      vi.mocked(ipc.mergeOutcome).mockResolvedValue('notMerged')
      setRun({
        stage: 'merge',
        runId: 'again',
        sessionId: 's',
        turnSince: 1000,
        observedWorking: true,
        sessionStartedMs: 1000,
      })
      await flush()
      expect(autoRun('p', 't')).toMatchObject({ stage: 'merge', status: 'paused' })
    })
  },
)

test.each(['closed', 'stopped', 'idle', 'forgotten'] as const)(
  'a %s merge agent checks Git after the user resolves the merge',
  async (state) => {
    load()
    agent('review', 1100)
    setRun({
      stage: 'merge',
      status: 'waitingOnYou',
      waitingFor: 'agentInput',
      sessionId: 's',
      sessionOwned: true,
      sessionStartedMs: 1000,
      turnSince: 1100,
    })
    if (state === 'forgotten') useStore.setState({ sessions: {}, serviceConnected: true })
    else if (state === 'idle') agent('idle', 1200)
    else
      useStore.setState({
        sessions: {
          s: {
            ...useStore.getState().sessions.s,
            running: state !== 'closed',
            status: { ...useStore.getState().sessions.s.status!, stopped: state === 'stopped' },
          },
        },
      })
    vi.mocked(ipc.mergeOutcome).mockResolvedValue('merged')
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')).toMatchObject({ stage: 'done', status: 'done' })
      expect(ipc.gitReview).not.toHaveBeenCalled()
      expect(jobs.startMergeAgent).not.toHaveBeenCalled()
      // Only an agent still at its prompt is left to stop; a finished run offers no Stop.
      if (state === 'idle') expect(ipc.terminalStop).toHaveBeenCalledWith('s')
      else expect(ipc.terminalStop).not.toHaveBeenCalled()
    })
  },
)

test.each(['notMerged', 'inProgress', 'dirty', 'error'] as const)(
  'a closed merge agent pauses when the Git outcome is %s',
  async (outcome) => {
    load()
    agent('idle', 1200)
    setRun({
      stage: 'merge',
      status: 'waitingOnYou',
      waitingFor: 'agentInput',
      sessionId: 's',
      turnSince: 1100,
    })
    if (outcome === 'error')
      vi.mocked(ipc.mergeOutcome).mockRejectedValue(new Error('Missing tree'))
    else vi.mocked(ipc.mergeOutcome).mockResolvedValue(outcome)
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')).toMatchObject({ stage: 'merge', status: 'paused' })
      expect(autoRun('p', 't')?.reason).toContain(
        outcome === 'error' ? 'Missing tree' : 'Agent stopped while waiting for input',
      )
    })
  },
)

test.each([true, false])(
  'a kept merge agent finishing its next turn completes Auto (working observed: %s)',
  async (observeWorking) => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    load()
    vi.mocked(ipc.mergeOutcome).mockResolvedValue('inProgress')
    agent('review', 1100)
    setRun({ stage: 'merge', sessionId: 's', turnSince: 1000 })
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')).toMatchObject({
        status: 'waitingOnYou',
        waitingFor: 'agentInput',
        turnSince: 1100,
      })
      await vi.advanceTimersByTimeAsync(5000)
      expect(ipc.mergeOutcome).toHaveBeenCalledOnce()
      if (observeWorking) {
        agent('working', 1200)
        await flush()
        expect(autoRun('p', 't')?.status).toBe('running')
      }
      vi.mocked(ipc.mergeOutcome).mockResolvedValue('merged')
      agent('review', 1300)
      await flush()
      expect(autoRun('p', 't')).toMatchObject({ stage: 'done', status: 'done' })
    })
  },
)

test('unrelated store updates do not rebuild session lifecycle selections', async () => {
  load()
  const records = useStore.getState().sessionRecords
  const scan = vi.spyOn(records, 'flatMap')
  const dispose = followAuto()
  try {
    await flush()
    scan.mockClear()
    for (let i = 0; i < 20; i++) useStore.getState().setMessage(`Output ${i}`)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  } finally {
    dispose()
    scan.mockRestore()
  }
})

test.each(['failed', 'paused'] as const)(
  'skipping a %s fix launch does not accept findings',
  async (status) => {
    load()
    setRun({ stage: 'fix', status, round: 0, reason: 'Launch failed' })
    await skipStage('p', 't')
    expect(autoRun('p', 't')).toMatchObject({ stage: 'review', status: 'running' })
  },
)

test.each(['working', 'review', 'needsInput'] as const)(
  'record-only %s sessions are tracked before hydration',
  async (state) => {
    vi.useFakeTimers()
    vi.setSystemTime(2000)
    load()
    const record = {
      ...plannerRecord(),
      id: 's',
      snapshot: {
        running: true,
        startedMs: 1000,
        status: { stopped: false, agent: { state, sinceMs: 1500, authoritative: true } },
      },
    }
    useStore.setState({ serviceConnected: true, sessionRecords: [record] as never, sessions: {} })
    vi.mocked(ipc.reviewRead).mockResolvedValue(findings())
    setRun({ sessionId: 's', sessionStartedMs: 1000, turnSince: 1100 })
    await withFollower(async () => {
      await flush()
      if (state === 'working')
        expect(autoRun('p', 't')).toMatchObject({ status: 'running', observedWorking: true })
      if (state === 'review')
        expect(autoRun('p', 't')).toMatchObject({ stage: 'mergeGate', status: 'waitingOnYou' })
      if (state === 'needsInput')
        expect(autoRun('p', 't')).toMatchObject({
          status: 'waitingOnYou',
          waitingFor: 'agentInput',
        })
    })
  },
)

test('record-only sessions still pause when their generation changes', async () => {
  load()
  useStore.setState({
    sessionRecords: [
      { ...plannerRecord(), id: 's', snapshot: { running: true, startedMs: 2000 } },
    ] as never,
  })
  setRun({ sessionId: 's', sessionStartedMs: 1000 })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      status: 'paused',
      reason: 'The tracked session was stopped or relaunched by hand',
    })
  })
})

test('Auto pauses legacy mixed-format findings instead of merging them', async () => {
  load()
  vi.mocked(ipc.reviewRead).mockResolvedValue({
    ...findings(),
    text: 'Verdict: issues\n- [low] Minor\n- **src/db.rs:42** [high] Data loss',
    verdict: null,
  })
  await withFollower(async () => {
    await startAuto('p', 't', {
      goal: 'Goal',
      effort: 'standard',
      device: 'codex',
      merge: { mode: 'auto', destinationBranch: 'main' },
    })
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ stage: 'review', status: 'paused' })
    expect(jobs.startMergeAgent).not.toHaveBeenCalled()
  })
})

test.each(['mergeGate', 'merge'] as const)(
  'a saved reviewed head at %s cannot bypass missing counts',
  async (stage) => {
    load()
    vi.mocked(ipc.reviewRead).mockResolvedValue({ ...findings(), verdict: null })
    setRun({ stage, reviewedHead: 'abc', merge: { mode: 'auto', destinationBranch: 'main' } })
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')).toMatchObject({ status: 'paused' })
      expect(jobs.startMergeAgent).not.toHaveBeenCalled()
    })
  },
)

test('a record without a snapshot waits for hydration instead of reporting a relaunch', async () => {
  load()
  useStore.setState({
    serviceConnected: true,
    sessionRecords: [{ ...plannerRecord(), id: 's', snapshot: null }] as never,
  })
  setRun({ sessionId: 's', sessionStartedMs: 1000 })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ status: 'running', sessionId: 's' })
    expect(jobs.startReviewAgent).not.toHaveBeenCalled()
  })
})

test.each(['refused', 'empty', 'unconfirmed'] as const)(
  'a %s fix launch never accepts findings on Skip, and uses a round only once it may run',
  async (failure) => {
    load()
    const { fixReviewFindings } = await import('./reviewHandoff')
    const { REVIEW_SCOPE } = await import('../types')
    useStore.setState({
      sessionRecords: [
        {
          id: 'reviewer',
          metadata: { projectId: 'p', componentId: REVIEW_SCOPE },
          spec: { cwd: tree.path },
        },
      ] as never,
    })
    if (failure === 'refused')
      vi.mocked(fixReviewFindings).mockRejectedValue(new Error('Launch refused'))
    else
      vi.mocked(fixReviewFindings).mockResolvedValue({
        sessionId: failure === 'empty' ? '' : 'unknown-session',
        requestId: undefined,
      })
    setRun({ stage: 'fix' })
    await withFollower(async () => {
      await flush()
      expect(fixReviewFindings).toHaveBeenCalledOnce()
      // An unconfirmed launch may have started an agent, so it counts against the budget.
      expect(autoRun('p', 't')).toMatchObject({
        status: 'failed',
        pauseKind: undefined,
        round: failure === 'unconfirmed' ? 1 : 0,
      })
      expect(autoRun('p', 't')?.sessionId).toBeUndefined()
      await skipStage('p', 't')
      expect(autoRun('p', 't')?.stage).toBe('review')
      expect(jobs.startMergeAgent).not.toHaveBeenCalled()
    })
  },
)

test('Start proceeds after Stop while a stale drive still waits, which then leaves the new run alone', async () => {
  load()
  let release!: (value: Worktree[]) => void
  vi.mocked(ipc.gitWorktrees).mockReturnValueOnce(
    new Promise<Worktree[]>((resolve) => {
      release = resolve
    }),
  )
  vi.mocked(jobs.startReviewAgent).mockImplementation(async () => {
    agent('working', Date.now())
    return 's'
  })
  setRun({ stage: 'review', effort: 'light' })
  await withFollower(async () => {
    await flush()
    expect(ipc.gitWorktrees).toHaveBeenCalledOnce()
    stopAuto('p', 't')
    await startAuto('p', 't', {
      goal: 'Goal',
      effort: 'light',
      merge: { mode: 'ask', destinationBranch: 'main' },
      device: 'codex',
    })
    const started = autoRun('p', 't')!
    expect(started).toMatchObject({ status: 'running', branch: 'feature' })
    release([tree, { ...tree, path: '/p', branch: 'main', current: true }])
    await flush()
    await flush()
    // Only the new run's own drive launches its reviewer.
    expect(jobs.startReviewAgent).toHaveBeenCalledOnce()
    expect(autoRun('p', 't')?.sessionId).toBe('s')
  })
})

test('a finished fix re-runs failed validation even when the effort skips validation', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  useStore.getState().addComponent({ x: 0, y: 0 })
  const id = useStore.getState().selectedId!
  vi.mocked(ipc.gitReview).mockResolvedValue({
    ahead: true,
    changes: { [id]: [{ path: 'file.txt', kind: 'modified' }] },
    affected: [],
  })
  const report = {
    plan: {
      request: { kind: 'validateChanged' as const, componentIds: [id] },
      sessions: ['check'],
      stages: [],
      skipped: [],
      task: 't',
    },
    results: [{ sessionId: 'check', outcome: 'failed' as const, exitCode: 1 }],
  }
  vi.mocked(ipc.graphActionRun).mockResolvedValue(report as never)
  // A Light run started at Validate, whose failures sent a clean review to Fix.
  setRun({
    stage: 'fix',
    effort: 'light',
    round: 0,
    validationFindings: '[high] Validation failed: check failed (exit 1)',
    sessionId: 's',
    turnSince: 1000,
  })
  agent('review', 1100)
  vi.mocked(ipc.reviewRead).mockResolvedValue(findings())
  await withFollower(async () => {
    await flush()
    await flush()
    expect(ipc.graphActionRun).toHaveBeenCalledOnce()
    const current = autoRun('p', 't')!
    expect(current.stage).not.toBe('mergeGate')
    expect(current.stage).not.toBe('merge')
    expect(current.validationFindings).toContain('[high] Validation failed')
    // Clean findings still don't permit a merge while validation fails.
    expect(reviewDecision(current, findings()).stage).toBe('fix')
    expect(
      mergeableHead(snapshot({ freshness: 'current', findings: findings() }), current),
    ).toBeUndefined()
  })
})

test.each(['review', 'merge'] as const)(
  'Auto follows a manual %s agent after its implementation finishes',
  async (stage) => {
    load()
    agent('review', 1400)
    useStore.setState({
      sessionRecords: [
        {
          id: 'manual',
          metadata: {
            projectId: 'p',
            componentId: stage === 'review' ? '@review' : '@merge',
            kind: 'agent',
          },
          spec: { cwd: stage === 'review' ? tree.path : '/p', merge_source: tree.path },
          snapshot: reviewSession('working', 1500),
        },
      ] as SessionRecord[],
    })
    setRun({
      stage: 'implement',
      sessionId: 's',
      turnSince: 1000,
      sessionOwned: true,
      sessionStartedMs: 1000,
    })
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')).toMatchObject({
        stage,
        sessionId: 'manual',
        sessionOwned: false,
        turnSince: 1500,
        status: 'running',
      })
      expect(ipc.terminalStop).toHaveBeenCalledWith('s')
      expect(ipc.terminalStop).not.toHaveBeenCalledWith('manual')
      expect(jobs.startReviewAgents).not.toHaveBeenCalled()
      expect(jobs.startMergeAgent).not.toHaveBeenCalled()
    })
  },
)

test.each([false, true])('Resume preserves idle reviewers (multiple: %s)', async (multiple) => {
  load()
  agent('idle', 1400)
  if (multiple)
    useStore.setState({
      sessions: { ...useStore.getState().sessions, lane: reviewSession('idle', 1400) },
    })
  setRun({
    status: 'paused',
    sessionId: 's',
    sessionOwned: true,
    sessionStartedMs: 1000,
    turnSince: 1000,
    laneSessions: multiple ? [{ sessionId: 'lane', startedMs: 1000 }] : undefined,
  })
  await resumeAuto('p', 't')
  await withFollower(async () => {
    await flush()
    expect(ipc.terminalStop).not.toHaveBeenCalled()
    expect(jobs.startReviewAgents).not.toHaveBeenCalled()
    expect(autoRun('p', 't')).toMatchObject({ stage: 'review', sessionId: 's' })
  })
})

test('a partially failed round pauses immediately and keeps the successful reviewer tracked', async () => {
  load()
  agent('working', 1400)
  vi.mocked(jobs.startReviewAgents).mockResolvedValue({
    started: [{ sessionId: 's', requestId: 'request-s', lane: 'codex' }],
    round: 'round',
    errors: ['Claude: launch unconfirmed'],
  })
  setRun()
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      status: 'paused',
      sessionId: 's',
      sessionOwned: true,
    })
    expect(autoRun('p', 't')?.reason).toContain('Claude: launch unconfirmed')
    expect(ipc.terminalStop).not.toHaveBeenCalled()
    stopAuto('p', 't')
    expect(ipc.terminalStop).toHaveBeenCalledWith('s')
  })
})

test.each([false, true])(
  'all reviewer completions must follow their own latest working turn (multiple: %s)',
  async (multiple) => {
    load()
    const sessions = {
      s: reviewSession('working', 2000),
      ...(multiple ? { lane: reviewSession('working', 2100) } : {}),
    }
    useStore.setState({ sessions })
    vi.mocked(ipc.reviewRead).mockResolvedValue(findings())
    setRun({
      sessionId: 's',
      turnSince: 1000,
      launchAtMs: 1000,
      laneSessions: multiple ? [{ sessionId: 'lane', startedMs: 1000 }] : undefined,
    })
    await withFollower(async () => {
      await flush()
      useStore.setState({
        sessions: {
          s: reviewSession('review', multiple ? 2200 : 1500),
          ...(multiple ? { lane: reviewSession('review', 1500) } : {}),
        },
      })
      await flush()
      expect(autoRun('p', 't')).toMatchObject({ stage: 'review', status: 'running' })
      expect(ipc.reviewRead).not.toHaveBeenCalled()
      useStore.setState({
        sessions: {
          s: reviewSession('review', 2200),
          ...(multiple ? { lane: reviewSession('review', 2300) } : {}),
        },
      })
      await flush()
      expect(autoRun('p', 't')?.stage).toBe('mergeGate')
    })
  },
)

test('Resume re-infers the stage once every tracked reviewer has stopped', async () => {
  load()
  useStore.setState({
    sessions: { s: { running: false, startedMs: 1000 }, lane: { running: false, startedMs: 1000 } },
  })
  setRun({
    status: 'paused',
    effort: 'light',
    sessionId: 's',
    sessionOwned: true,
    sessionStartedMs: 1000,
    laneSessions: [{ sessionId: 'lane', startedMs: 1000 }],
  })
  await resumeAuto('p', 't')
  expect(autoRun('p', 't')).toMatchObject({
    stage: 'review',
    status: 'running',
    sessionId: undefined,
    laneSessions: undefined,
  })
  expect(ipc.terminalStop).not.toHaveBeenCalled()
})

const reviewRecord = (id: string, lane: string | null, snapshot: SessionState, requestIds = []) =>
  ({
    id,
    snapshot,
    requestIds,
    metadata: {
      projectId: 'p',
      componentId: '@review',
      kind: 'agent',
      name: `Review ${id}`,
      ...(lane ? { lane } : {}),
    },
    spec: { cwd: tree.path },
  }) as unknown as SessionRecord
function loadReviewRound({
  sessions,
  auto,
  findings: report = null,
  records = Object.entries(sessions).map(([id, snapshot]) =>
    reviewRecord(id, id === 's' ? 'codex' : 'claude', snapshot),
  ),
}: {
  sessions: Record<string, SessionState>
  auto: Partial<AutoRun>
  findings?: ReviewFindings | null
  records?: SessionRecord[]
}) {
  load()
  useStore.setState({ sessions, sessionRecords: records })
  vi.mocked(ipc.reviewRead).mockResolvedValue(report)
  setRun(auto)
}
const reviewer = (lane: string | null, finished: boolean, error: string | null = null) => ({
  lane,
  finished,
  verdict: null,
  error,
})
const pausedRound = (laneStartedMs?: number) =>
  run({
    status: 'paused',
    effort: 'light',
    sessionId: 's',
    sessionOwned: true,
    sessionStartedMs: 1000,
    turnSince: 1000,
    launchAtMs: 1000,
    laneSessions: [{ sessionId: 'lane', startedMs: laneStartedMs ?? 1000 }],
  })

test.each(['stopped', 'crashed', 'forgotten'] as const)(
  'Resume reviews again when a reviewer %s before writing, stopping the round it still owns',
  async (failure) => {
    const lane = reviewSession('working')
    if (failure === 'stopped') lane.status!.stopped = true
    if (failure === 'crashed') lane.running = false
    const sessions = { s: reviewSession('review'), ...(failure === 'forgotten' ? {} : { lane }) }
    loadReviewRound({
      sessions,
      auto: pausedRound(),
      findings: {
        ...findings(),
        reviewedHead: null,
        verdict: null,
        reviewers: [reviewer('claude', false), reviewer('codex', true)],
      },
    })
    await resumeAuto('p', 't')
    expect(ipc.terminalStop).toHaveBeenCalledWith('s')
    expect(ipc.terminalStop).not.toHaveBeenCalledWith('lane')
    expect(autoRun('p', 't')).toMatchObject({
      stage: 'review',
      status: 'running',
      sessionId: undefined,
      laneSessions: undefined,
    })
    expect(autoRun('p', 't')?.log.at(-1)?.text).toContain('the review round ended early')
  },
)

test('Resume keeps tracking live reviewers when one that exited had already written', async () => {
  loadReviewRound({
    sessions: { s: { running: false, startedMs: 1000 }, lane: reviewSession('working') },
    auto: pausedRound(),
    findings: {
      ...findings(),
      reviewedHead: null,
      verdict: null,
      reviewers: [reviewer('claude', false), reviewer('codex', true)],
    },
  })
  await resumeAuto('p', 't')
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  // The live reviewer leads, keeping the ownership it had as a lane.
  expect(autoRun('p', 't')).toMatchObject({
    stage: 'review',
    status: 'running',
    sessionId: 'lane',
    sessionOwned: true,
    sessionStartedMs: 1000,
    launchAtMs: 1000,
    laneSessions: undefined,
  })
})

test('a reviewer whose launch was never confirmed pauses with what to do, and Resume reviews again', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(2000)
  loadReviewRound({
    sessions: { s: reviewSession('review', 1500) },
    auto: {
      sessionId: 's',
      sessionOwned: true,
      sessionStartedMs: 1000,
      turnSince: 1000,
      launchAtMs: 1000,
    },
    findings: {
      ...findings(),
      reviewedHead: null,
      verdict: null,
      reviewers: [reviewer('claude', false, 'Reply lost'), reviewer('codex', true)],
    },
  })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      status: 'paused',
      reason: 'claude may not have started: Reply lost. Resume to review again',
    })
  })
  await resumeAuto('p', 't')
  expect(ipc.terminalStop).toHaveBeenCalledWith('s')
  // Standard effort validates the changed work before reviewing it again.
  expect(autoRun('p', 't')).toMatchObject({
    stage: 'validate',
    status: 'running',
    sessionId: undefined,
  })
})

test('only the reviewer an input wait opened counts as stopped when it goes idle', async () => {
  load()
  setRun({
    status: 'waitingOnYou',
    waitingFor: 'agentInput',
    inputSessionId: 'lane',
    sessionId: 's',
    turnSince: 1000,
    launchAtMs: 1000,
    laneSessions: [{ sessionId: 'lane', startedMs: 1000 }],
  })
  // The primary's provider confirms it idle at its prompt; it was never seen working.
  useStore.setState({
    sessions: { s: reviewSession('idle', 1300), lane: reviewSession('needsInput', 1200) },
  })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ status: 'waitingOnYou', inputSessionId: 'lane' })
    // Only the lane resumed: the primary still hasn't been seen working.
    useStore.setState({
      sessions: { s: reviewSession('idle', 1300), lane: reviewSession('working', 1400) },
    })
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      status: 'running',
      laneSessions: [{ sessionId: 'lane', observedWorking: true }],
    })
    expect(autoRun('p', 't')?.observedWorking).toBeFalsy()
    // The waiting reviewer itself going idle is a stop.
    useStore.getState().patchTask('p', 't', {
      auto: {
        ...autoRun('p', 't')!,
        status: 'waitingOnYou',
        waitingFor: 'agentInput',
        inputSessionId: 'lane',
        laneSessions: [{ sessionId: 'lane', startedMs: 1000 }],
      },
    })
    useStore.setState({
      sessions: { s: reviewSession('idle', 1300), lane: reviewSession('idle', 1500) },
    })
    await flush()
    expect(autoRun('p', 't')?.status).toBe('paused')
    expect(autoRun('p', 't')?.reason).toContain('stopped while waiting for input')
  })
})

test.each([true, false])(
  'a reviewer whose start time was unreadable is stopped only while its launch is the latest (relaunched: %s)',
  async (relaunchedByHand) => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    load()
    const codex = useStore.getState().devices[0]
    useStore.setState({ devices: [codex, { ...codex, id: 'claude' }] })
    vi.mocked(jobs.startReviewAgent).mockImplementation(async (_p, request) => {
      useStore.setState({ sessions: { s: reviewSession('working'), lane: { running: true } } })
      return request.lane === 'claude' ? 'lane' : 's'
    })
    vi.mocked(ipc.terminalSnapshot).mockRejectedValue(new Error('Service busy'))
    await withFollower(async () => {
      await startAuto('p', 't', { ...run(), effort: 'light', reviewers: ['codex', 'claude'] })
      await flush()
      expect(autoRun('p', 't')?.laneSessions).toMatchObject([
        { sessionId: 'lane', startedMs: undefined, requestId: 'request-lane' },
      ])
      vi.mocked(awaitSessions.reconcileFreshSessions).mockImplementation(async () => {
        useStore.setState({
          sessionRecords: [
            reviewRecord('lane', 'claude', { running: true }, [
              'request-lane',
              ...(relaunchedByHand ? ['by-hand'] : []),
            ] as never),
          ],
        })
      })
      vi.mocked(ipc.terminalSnapshot).mockResolvedValue({ startedMs: 1200, running: true } as never)
      // Records this window holds may be stale: the stop refreshes them once first.
      useStore.setState({
        sessionRecords: [
          reviewRecord('lane', 'claude', { running: true }, ['request-lane'] as never),
        ],
      })
      vi.mocked(awaitSessions.reconcileFreshSessions).mockClear()
      stopAuto('p', 't')
      await flush()
      expect(awaitSessions.reconcileFreshSessions).toHaveBeenCalledTimes(1)
      if (relaunchedByHand) expect(ipc.terminalStop).not.toHaveBeenCalledWith('lane')
      else expect(ipc.terminalStop).toHaveBeenCalledWith('lane')
    })
  },
)

test('a lane that takes the lead without a start time stays owned through its launch request', async () => {
  const sessions = { s: { running: false, startedMs: 1000 }, lane: reviewSession('working') }
  delete (sessions.lane as Partial<SessionState>).startedMs
  loadReviewRound({
    sessions,
    records: [
      reviewRecord('s', 'codex', sessions.s),
      reviewRecord('lane', 'claude', sessions.lane, ['req-lane'] as never),
    ],
    auto: {
      ...pausedRound(),
      reviewRound: 'round',
      sessionLane: 'codex',
      laneSessions: [{ sessionId: 'lane', requestId: 'req-lane', lane: 'claude' }],
    },
    findings: {
      ...findings(),
      reviewedHead: null,
      verdict: null,
      reviewers: [reviewer('claude', false), reviewer('codex', true)],
    },
  })
  await resumeAuto('p', 't')
  expect(autoRun('p', 't')).toMatchObject({
    sessionId: 'lane',
    sessionOwned: true,
    sessionStartedMs: undefined,
    sessionRequestId: 'req-lane',
    sessionLane: 'claude',
    reviewRound: 'round',
  })
  vi.mocked(ipc.terminalSnapshot).mockResolvedValue({ running: true } as never)
  stopAuto('p', 't')
  await flush()
  expect(ipc.terminalStop).toHaveBeenCalledWith('lane')
})

test('a reviewer forgotten after writing its findings does not break the round on Resume', async () => {
  loadReviewRound({
    sessions: { lane: reviewSession('working') },
    auto: {
      ...pausedRound(),
      reviewRound: 'round',
      sessionLane: 'codex',
      laneSessions: [{ sessionId: 'lane', startedMs: 1000, lane: 'claude' }],
    },
    findings: {
      ...findings(),
      reviewedHead: null,
      verdict: null,
      reviewers: [reviewer('claude', false), reviewer('codex', true)],
    },
  })
  await resumeAuto('p', 't')
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  expect(autoRun('p', 't')).toMatchObject({ stage: 'review', sessionId: 'lane' })
})

test('Resume never stops a reviewer restarted by hand while it checked hooks', async () => {
  const sessions = {
    s: { ...reviewSession('working'), running: false },
    lane: reviewSession('working'),
  }
  loadReviewRound({
    sessions,
    auto: pausedRound(),
  })
  vi.mocked(ipc.agentHooksCheck).mockImplementation(async () => {
    // The user restarts the lane's tile meanwhile: a new generation.
    useStore.setState({
      sessions: { ...useStore.getState().sessions, lane: { ...sessions.lane, startedMs: 5000 } },
    })
    return { installed: true, disabled: false, reporterAvailable: true } as Awaited<
      ReturnType<typeof ipc.agentHooksCheck>
    >
  })
  // It can't be stopped, so Resume asks to close it rather than review beside it.
  await expect(resumeAuto('p', 't')).rejects.toThrow("Close Review lane, which Auto can't tell")
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  expect(autoRun('p', 't')?.status).toBe('paused')
})

test("a review someone else started while paused supersedes Auto's round on Resume", async () => {
  loadReviewRound({
    sessions: { s: reviewSession('review'), lane: reviewSession('review') },
    auto: {
      ...pausedRound(),
      reviewRound: 'round',
      sessionLane: 'codex',
      laneSessions: [{ sessionId: 'lane', startedMs: 1000, lane: 'claude' }],
    },
    // The newer, manual round: a single reviewer whose launch error isn't Auto's.
    findings: {
      ...findings(),
      round: 'manual',
      reviewedHead: null,
      verdict: null,
      reviewers: [reviewer(null, false, 'Reply lost')],
    },
  })
  await resumeAuto('p', 't')
  expect(ipc.terminalStop).toHaveBeenCalledWith('s')
  expect(ipc.terminalStop).toHaveBeenCalledWith('lane')
  expect(autoRun('p', 't')).toMatchObject({ sessionId: undefined, reviewRound: undefined })
  expect(autoRun('p', 't')?.log.at(-1)?.text).toContain("a newer review replaced Auto's round")
})

test('a reviewer that went idle at its prompt pauses, and Resume reviews again instead of re-pausing', async () => {
  const sessions = { s: reviewSession('idle', 1300) }
  loadReviewRound({
    sessions,
    records: [reviewRecord('s', null, sessions.s)],
    auto: {
      sessionId: 's',
      sessionOwned: true,
      sessionStartedMs: 1000,
      turnSince: 1000,
      launchAtMs: 1000,
      observedWorking: true,
    },
  })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ status: 'paused' })
  })
  await resumeAuto('p', 't')
  expect(ipc.terminalStop).toHaveBeenCalledWith('s')
  expect(autoRun('p', 't')).toMatchObject({ status: 'running', sessionId: undefined })
})

test('a reviewer that idles once its input wait is no longer open still counts as stopped', async () => {
  load()
  setRun({
    sessionId: 's',
    turnSince: 1000,
    launchAtMs: 1000,
    laneSessions: [{ sessionId: 'lane', startedMs: 1000 }],
  })
  useStore.setState({
    sessions: { s: reviewSession('working', 1100), lane: reviewSession('needsInput', 1200) },
  })
  await withFollower(async () => {
    await flush()
    // Asking for input is part of a turn, so the lane counts as seen working.
    expect(autoRun('p', 't')).toMatchObject({
      status: 'waitingOnYou',
      inputSessionId: 'lane',
      laneSessions: [{ sessionId: 'lane', observedWorking: true }],
    })
    // The wait no longer names it (as after Pause and Resume); then it idles without working.
    useStore.getState().patchTask('p', 't', {
      auto: { ...autoRun('p', 't')!, status: 'running', inputSessionId: undefined },
    })
    useStore.setState({
      sessions: { s: reviewSession('working', 1100), lane: reviewSession('idle', 1400) },
    })
    await flush()
    expect(autoRun('p', 't')?.status).toBe('paused')
    expect(autoRun('p', 't')?.reason).toContain('Resume to review again')
  })
})

test('a review started by someone else during the run pauses at completion instead of judging it', async () => {
  load()
  useStore.setState({ sessions: { s: reviewSession('review', 1500) } })
  vi.mocked(ipc.reviewRead).mockResolvedValue({ ...findings(), round: 'manual' })
  setRun({ sessionId: 's', turnSince: 1000, launchAtMs: 1000, reviewRound: 'round' })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      stage: 'review',
      status: 'paused',
      reason: "A newer review replaced Auto's round; Resume to continue from it",
    })
  })
})

test('Resume waits for the session service and never forgets a known start time', async () => {
  load()
  useStore.setState({ serviceConnected: false, sessions: {} })
  useStore.getState().patchTask('p', 't', { auto: pausedRound() })
  await expect(resumeAuto('p', 't')).rejects.toThrow('Wait for the session service')
  // Connected, but this window hasn't hydrated the sessions yet: records alone vouch for them.
  const record = (id: string) => reviewRecord(id, null, null as unknown as SessionState)
  useStore.setState({ serviceConnected: true, sessionRecords: [record('s'), record('lane')] })
  await resumeAuto('p', 't')
  expect(autoRun('p', 't')).toMatchObject({
    sessionId: 's',
    sessionOwned: true,
    sessionStartedMs: 1000,
    laneSessions: [{ sessionId: 'lane', startedMs: 1000 }],
  })
})

test.each([
  ['the slot runs another terminal', `Codex: Error: ${TERMINAL_RUNNING}`, 'paused'],
  ['its conversation runs elsewhere', 'Codex: Conversation is already running', 'failed'],
] as const)('a review launch refused because %s', async (_name, error, status) => {
  load()
  vi.mocked(jobs.startReviewAgents).mockRejectedValue(new Error(error))
  setRun()
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')?.status).toBe(status)
    expect(autoRun('p', 't')?.pauseKind).toBe(status === 'paused' ? 'needsUser' : undefined)
    if (error.includes(TERMINAL_RUNNING))
      expect(autoRun('p', 't')?.reason).toBe('Close the current agent in this slot, then Resume')
  })
})

const roundFindings = (claude: boolean, codex: boolean): ReviewFindings => ({
  ...findings(),
  reviewedHead: claude && codex ? 'abc' : null,
  verdict: claude && codex ? findings().verdict : null,
  reviewers: [reviewer('claude', claude), reviewer('codex', codex)],
})
const inputWaitRound = () =>
  run({
    status: 'waitingOnYou',
    waitingFor: 'agentInput',
    inputSessionId: 's',
    effort: 'light',
    sessionId: 's',
    sessionOwned: true,
    sessionStartedMs: 1000,
    sessionLane: 'claude',
    reviewRound: 'round',
    turnSince: 1000,
    launchAtMs: 1000,
    observedWorking: true,
    laneSessions: [{ sessionId: 'lane', startedMs: 1000, lane: 'codex' }],
  })

test('a reviewer that exits after writing during an input wait is settled, and the round completes', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(2000)
  load()
  // The other reviewer wrote its findings and exited without reporting the end of its turn.
  const exited = { ...reviewSession('working', 1100), running: false }
  useStore.setState({ sessions: { s: reviewSession('needsInput', 1200), lane: exited } })
  vi.mocked(ipc.reviewRead).mockResolvedValue(roundFindings(false, true))
  useStore.getState().patchTask('p', 't', { auto: inputWaitRound() })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      status: 'waitingOnYou',
      inputSessionId: 's',
      laneSessions: undefined,
    })
    // The user answers; the waiting reviewer works and finishes.
    useStore.setState({ sessions: { s: reviewSession('working', 1500) } })
    await flush()
    expect(autoRun('p', 't')?.status).toBe('running')
    vi.mocked(ipc.reviewRead).mockResolvedValue(roundFindings(true, true))
    useStore.setState({ sessions: { s: reviewSession('review', 1600) } })
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    await flush()
    expect(autoRun('p', 't')?.stage).toBe('mergeGate')
  })
})

test('Pause during the findings check of a failed reviewer is kept', async () => {
  load()
  const exited = { ...reviewSession('working', 1100), running: false }
  // The round is complete: one reviewer finished its turn, the other wrote and exited.
  useStore.setState({ sessions: { s: reviewSession('review', 1300), lane: exited } })
  let answer!: (findings: ReviewFindings) => void
  vi.mocked(ipc.reviewRead).mockReturnValue(new Promise((resolve) => (answer = resolve)))
  useStore.getState().patchTask('p', 't', {
    auto: {
      ...inputWaitRound(),
      status: 'running',
      waitingFor: undefined,
      inputSessionId: undefined,
    },
  })
  await withFollower(async () => {
    await flush()
    pauseAuto('p', 't')
    answer(roundFindings(true, true))
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      status: 'paused',
      reason: 'Paused by you',
      laneSessions: [{ sessionId: 'lane' }],
    })
    expect(ipc.terminalStop).not.toHaveBeenCalled()
  })
})

test('Resume of a superseded round stops only what Auto owns and follows the newer review', async () => {
  // The newer review relaunched the lane's slot; Auto's own reviewer still runs.
  loadReviewRound({
    sessions: {
      s: reviewSession('review'),
      lane: { ...reviewSession('working', 3000), startedMs: 5000 },
    },
    auto: {
      ...pausedRound(),
      reviewRound: 'round',
      sessionLane: 'codex',
      laneSessions: [{ sessionId: 'lane', startedMs: 1000, lane: 'claude' }],
    },
    findings: {
      ...findings(),
      round: 'manual',
      reviewedHead: null,
      verdict: null,
      reviewers: [reviewer('claude', false)],
    },
  })
  await resumeAuto('p', 't')
  expect(ipc.terminalStop).toHaveBeenCalledWith('s')
  expect(ipc.terminalStop).not.toHaveBeenCalledWith('lane')
  // The newer review's working reviewer is followed, not owned.
  expect(autoRun('p', 't')).toMatchObject({
    stage: 'review',
    status: 'running',
    sessionId: 'lane',
    sessionOwned: false,
    reviewRound: undefined,
  })
})

test('the needs-worktree view reloads only once the base it was judged from may change', async () => {
  const { NoReviewBase, reviewBaseMoved } = await import('./auto')
  load()
  const folder = { ...tree, path: '/p', branch: 'main', current: true }
  vi.mocked(ipc.gitWorktrees).mockResolvedValue([tree, folder])
  vi.mocked(ipc.gitBranches).mockResolvedValue(['main'])
  const judged = await autoSnapshot('p', null, run()).then(
    () => null,
    (e: unknown) => e as InstanceType<typeof NoReviewBase>,
  )
  expect(judged).toBeInstanceOf(NoReviewBase)
  vi.mocked(ipc.planRead).mockClear()
  expect(await reviewBaseMoved('p', judged!)).toBe(false)
  vi.mocked(ipc.gitBranches).mockResolvedValue(['main', 'feature'])
  expect(await reviewBaseMoved('p', judged!)).toBe(true)
  vi.mocked(ipc.gitBranches).mockResolvedValue(['main'])
  vi.mocked(ipc.gitWorktrees).mockResolvedValue([tree, { ...folder, branch: 'feature' }])
  expect(await reviewBaseMoved('p', judged!)).toBe(true)
  vi.mocked(ipc.gitWorktrees).mockResolvedValue([tree, folder])
  // Attaching the project folder as a worktree with a base gives it something to review against.
  useStore
    .getState()
    .setTasks([
      ...useStore.getState().tasks,
      { ...useStore.getState().tasks[0], id: 'f', worktree: '/p', branch: 'main', base: 'develop' },
    ])
  expect(await reviewBaseMoved('p', judged!)).toBe(true)
  expect(ipc.planRead).not.toHaveBeenCalled()
})

test('findings that left out untracked files stay current but never merge automatically', () => {
  const clean = findings()
  const current = run({ stage: 'review' })
  expect(mergeableHead(snapshot({ freshness: 'current', findings: clean }), current)).toBe(
    tree.head,
  )
  const uncovered = { ...clean, uncovered: true }
  // Still current, so the run moves on to the merge gate rather than reviewing again.
  expect(reviewDecision(current, uncovered).stage).toBe('mergeGate')
  expect(
    mergeableHead(snapshot({ freshness: 'current', findings: uncovered }), current),
  ).toBeUndefined()
})

test('Auto offers integration setup for a missing saved Codex hook source', async () => {
  load()
  const { setHookSource } = await import('./agentHooks')
  const { checkAutoHooks, AutoHooksRequired } = await import('./auto')
  setHookSource('codex', '/gone/hooks.json')
  vi.mocked(ipc.agentProvider).mockResolvedValueOnce('codex')
  vi.mocked(ipc.agentHooksCheck).mockRejectedValueOnce(new Error('No such directory'))
  const error = await checkAutoHooks(useStore.getState().devices[0].id).catch((e) => e)
  expect(error).toBeInstanceOf(AutoHooksRequired)
  expect(error.provider).toBe('codex')
  expect(error.message).toContain('Install Agent status integration')
  expect(ipc.agentHooksCheck).toHaveBeenCalledWith('codex', '/gone/hooks.json')
})

test('plan marks remain compatible with paused runs saved before proposal timestamps', async () => {
  load()
  vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
  const proposal = { version: 1, plan: '# Same proposal', assignments: [] }
  vi.mocked(ipc.planRead).mockResolvedValue({ text: '', cut: false })
  vi.mocked(ipc.proposalRead).mockResolvedValue(proposal)
  const planning = run({ stage: 'plan', status: 'paused' })
  const old = await autoSnapshot('p', 't', planning)
  const { fnv1a } = await import('./hash')
  const legacy = JSON.stringify(['', proposal])
  expect(old.planMark).toBe(`${legacy.length}:${fnv1a(legacy).toString(16)}`)
  // Timestamp metadata may be serialized first by a newer backend.
  vi.mocked(ipc.proposalRead).mockResolvedValue({ savedMs: 10000, ...proposal })
  const current = await autoSnapshot('p', 't', planning)
  expect(current.planMark).toBe(old.planMark)
  expect(inferStage(current, { ...planning, planMark: old.planMark }).stage).toBe('plan')
  vi.mocked(ipc.proposalRead).mockResolvedValue({
    ...proposal,
    plan: '# New proposal',
    savedMs: 10001,
  })
  const changed = await autoSnapshot('p', 't', planning)
  expect(inferStage(changed, { ...planning, planMark: old.planMark }).stage).toBe('implement')
})

test.each(['reset', 'threshold', 'disable'] as const)(
  'usage gate pauses before parallel reviewers launch and rechecks on resume (%s)',
  async (resume) => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    load()
    const codex = useStore.getState().devices[0]
    useStore.setState({
      devices: [
        codex,
        { ...codex, id: 'claude', name: 'Claude', command: 'claude', adapter: 'claude' },
      ],
    })
    vi.mocked(ipc.agentProvider).mockImplementation(async (d) =>
      d.adapter === 'claude' ? 'claude' : 'codex',
    )
    const data = {
      claude: {
        provider: 'claude' as const,
        fiveHour: null,
        weekly: { usedPercent: 96, resetsAtMs: 2000, windowMinutes: 10080 },
        observedMs: 1000,
      },
      codex: null,
      claudeCapture: { installed: true, chained: null, source: '/settings.json' },
      claudeError: null,
      codexError: null,
    }
    vi.mocked(ipc.usageRead).mockResolvedValue(data)
    vi.mocked(jobs.startReviewAgent).mockImplementation(async (_p, request) => {
      useStore.setState({
        sessions: { s: reviewSession('working'), lane: reviewSession('working') },
      })
      return request.lane === 'claude' ? 'lane' : 's'
    })
    await withFollower(async () => {
      await startAuto('p', 't', { ...run(), effort: 'light', reviewers: ['codex', 'claude'] })
      await flush()
      expect(autoRun('p', 't')).toMatchObject({ status: 'paused', stage: 'review' })
      expect(autoRun('p', 't')?.reason).toMatch(/^Claude weekly limit is 96% used; resets /)
      expect(jobs.startReviewAgents).not.toHaveBeenCalled()
      if (resume === 'reset') vi.setSystemTime(2000)
      else
        useStore.getState().setUsageSettings({
          ...useStore.getState().usageSettings,
          ...(resume === 'disable' ? { gateAuto: false } : { pausePercent: 100 }),
        })
      await resumeAuto('p', 't')
      await flush()
      expect(jobs.startReviewAgents).toHaveBeenCalledTimes(1)
      expect(jobs.startReviewAgent).toHaveBeenCalledTimes(2)
    })
  },
)

test.each([false, true])(
  'launching an inactive worktree requires background permission (%s)',
  async (background) => {
    load()
    useStore.getState().setActiveTask(null, true)
    const settings = {
      goal: 'Background goal',
      effort: 'light' as const,
      device: 'codex',
      background,
      merge: { mode: 'ask' as const, destinationBranch: 'main' },
    }
    if (background) {
      await startAuto('p', 't', settings)
      expect(autoRun('p', 't')).toMatchObject({ status: 'running', background: true })
    } else {
      await expect(startAuto('p', 't', settings)).rejects.toThrow('The task changed')
      expect(autoRun('p', 't')).toBeNull()
    }
    expect(useStore.getState().activeTask).toBeNull()
  },
)

test('a background run starts a review in an inactive project tab without changing the UI', async () => {
  load()
  setRun({ background: true })
  useStore.getState().loadProject({
    projectId: 'q',
    root: '/q',
    name: 'Q',
    schemaVersion: 4,
    components: [],
    links: [],
  })
  vi.mocked(jobs.startReviewAgent).mockImplementation(async () => {
    useStore.setState({ sessions: { 'bg-review': { running: true, startedMs: Date.now() } } })
    return 'bg-review'
  })
  await withFollower(async () => {
    await flush()
    expect(jobs.startReviewAgent).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p' }),
      expect.objectContaining({ worktree: '/p/feature', branch: 'feature' }),
      expect.anything(),
      expect.any(String),
      expect.anything(),
    )
    expect(autoRun('p', 't')).toMatchObject({ status: 'running', sessionId: 'bg-review' })
    expect(useStore.getState().project?.id).toBe('q')
    expect(useStore.getState().activeTask).toBeNull()
  })
})

test('foreground runs pause as inactive and a user Pause replaces that reason', async () => {
  load()
  setRun()
  useStore.getState().setActiveTask(null, true)
  await withFollower(async (dispose) => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      status: 'paused',
      pauseKind: 'inactive',
      pausedMs: expect.any(Number),
    })
    expect(jobs.startReviewAgent).not.toHaveBeenCalled()
    pauseAuto('p', 't')
    expect(autoRun('p', 't')).toMatchObject({ pauseKind: 'user', reason: 'Paused by you' })
    dispose()
    await resumeAuto('p', 't')
    expect(autoRun('p', 't')).toMatchObject({ pauseKind: undefined, pausedMs: undefined })
  })
})

test('service disconnection waits without pausing and reconnect continues driving', async () => {
  load()
  setRun({ sessionId: 's' })
  agent('working', 2000)
  useStore.setState({ serviceConnected: false })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      status: 'running',
      sessionId: 's',
    })
    expect(ipc.reviewRead).not.toHaveBeenCalled()
    expect(jobs.startReviewAgent).not.toHaveBeenCalled()
    useStore.setState({ serviceConnected: true })
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ status: 'running', observedWorking: true })
    expect(autoRun('p', 't')?.pauseKind).toBeUndefined()
  })
})

test('background runs wait for a shared planner through its implementation handoff', async () => {
  vi.useFakeTimers()
  load()
  vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
  setRun({ stage: 'plan', background: true })
  useStore.getState().setActiveTask(null, true)
  useStore.getState().patchTask('p', null, {
    auto: run({
      runId: 'second',
      stage: 'plan',
      background: true,
      merge: { mode: 'ask', destinationBranch: 'feature' },
    }),
  })
  // A recorded planner owns the project even if a different preset would get another session id.
  setRun({ stage: 'plan', background: true, sessionId: 'owner', planMark: 'old' })
  useStore.setState({ sessions: { owner: reviewSession('working', 1500) } })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', null)).toMatchObject({
      status: 'running',
      reason: 'Waiting for the planner',
    })
    expect(awaitSessions.startTerminal).not.toHaveBeenCalled()
    const { implementPlannerPlan } = await import('./planHandoff')
    let finish!: () => void
    vi.mocked(implementPlannerPlan).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ sessionId: 'implementation', requestId: 'r' })
        }),
    )
    setRun({ stage: 'implement', background: true, planMark: 'old' })
    await flush()
    expect(implementPlannerPlan).toHaveBeenCalledOnce()
    expect(awaitSessions.startTerminal).not.toHaveBeenCalled()
    finish()
    vi.mocked(awaitSessions.startTerminal).mockImplementation(async () => {
      const { plannerSessionId } = await import('../types')
      const sid = plannerSessionId('codex', 'p')
      useStore.setState({
        sessions: {
          ...useStore.getState().sessions,
          [sid]: { running: true, startedMs: Date.now() },
        },
      })
      return 'request'
    })
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    await flush()
    expect(awaitSessions.startTerminal).toHaveBeenCalledOnce()
    expect(awaitSessions.startTerminal).toHaveBeenCalledWith(
      '@plan',
      'codex',
      null,
      'p',
      expect.anything(),
    )
    expect(autoRun('p', null)?.status).toBe('running')
  })
})

test.each(['agentInput', undefined] as const)(
  'a disconnect preserves a user wait instead of making it resumable (%s)',
  async (waitingFor) => {
    load()
    setRun({
      status: 'waitingOnYou',
      stage: waitingFor ? 'review' : 'mergeGate',
      waitingFor,
      sessionId: waitingFor ? 's' : undefined,
    })
    useStore.setState({ serviceConnected: false })
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')?.status).toBe('waitingOnYou')
      expect(autoRun('p', 't')?.pauseKind).toBeUndefined()
    })
  },
)

test('a partial launch failure cannot replace a user pause made while reviewers started', async () => {
  load()
  let finish!: () => void
  vi.mocked(jobs.startReviewAgents).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            started: [{ sessionId: 's', requestId: 'r', lane: null }],
            round: 'round',
            errors: ['Other reviewer failed'],
          })
      }),
  )
  setRun()
  await withFollower(async () => {
    await flush()
    expect(jobs.startReviewAgents).toHaveBeenCalledOnce()
    pauseAuto('p', 't')
    agent('working', 1400)
    finish()
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      status: 'paused',
      pauseKind: 'user',
      reason: 'Paused by you',
      sessionId: 's',
    })
  })
})

test.each([false, true])(
  'a start does not adopt another worktree’s planner (background: %s)',
  async (background) => {
    load()
    vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
    const record = plannerRecord()
    useStore.setState({ sessionRecords: [record], sessions: { s: reviewSession('working', 1500) } })
    useStore
      .getState()
      .patchTask('p', null, { auto: run({ runId: 'owner', stage: 'plan', sessionId: 's' }) })
    await startAuto('p', 't', {
      goal: 'Another goal',
      effort: 'light',
      device: 'codex',
      background,
      merge: { mode: 'ask', destinationBranch: 'main' },
    })
    expect(autoRun('p', 't')).toMatchObject({
      status: 'running',
      stage: 'plan',
    })
    expect(autoRun('p', 't')?.sessionId).toBeUndefined()
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')).toMatchObject({
        status: 'running',
        reason: 'Waiting for the planner',
      })
      expect(awaitSessions.startTerminal).not.toHaveBeenCalled()
    })
  },
)

test('a handoff keeps priority over a waiting planner when controller reservations are rebuilt', async () => {
  load()
  vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
  setRun({ stage: 'implement', background: true, planMark: 'accepted' })
  useStore.getState().setActiveTask(null, true)
  useStore.getState().patchTask('p', null, {
    auto: run({
      runId: 'next',
      stage: 'plan',
      background: true,
      planMark: 'waiting',
      merge: { mode: 'ask', destinationBranch: 'feature' },
    }),
  })
  const { implementPlannerPlan } = await import('./planHandoff')
  let finish!: () => void
  vi.mocked(implementPlannerPlan).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ sessionId: 'implementation', requestId: 'r' })
      }),
  )
  const dispose = followAuto()
  try {
    await flush()
    expect(implementPlannerPlan).toHaveBeenCalledOnce()
    expect(vi.mocked(implementPlannerPlan).mock.calls[0][4]).toEqual({ projectId: 'p', task: 't' })
    expect(awaitSessions.startTerminal).not.toHaveBeenCalled()
    expect(autoRun('p', null)).toMatchObject({
      status: 'running',
      reason: 'Waiting for the planner',
    })
  } finally {
    dispose()
    finish()
    await flush()
  }
})

test.each(['preset', 'destination', 'base', 'branch'] as const)(
  'invalid %s pauses for user action instead of automatic retry',
  async (problem) => {
    load()
    const stage = problem === 'destination' ? 'merge' : 'review'
    setRun({ stage, merge: { mode: 'auto', destinationBranch: 'main' } })
    if (problem === 'preset') useStore.setState({ devices: [] })
    if (problem === 'destination')
      setRun({ stage, merge: { mode: 'auto', destinationBranch: 'missing' } })
    if (problem === 'base') {
      vi.mocked(ipc.gitBranches).mockResolvedValue(['feature'])
      vi.mocked(ipc.gitWorktrees).mockResolvedValue([{ ...tree, current: true }])
      useStore
        .getState()
        .setTasks(useStore.getState().tasks.map((t) => ({ ...t, base: 'feature' })))
    }
    if (problem === 'branch') vi.mocked(ipc.gitWorktrees).mockResolvedValue([])
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')).toMatchObject({ status: 'paused', pauseKind: 'needsUser' })
      const { autoAttentionItems } = await import('./attention')
      expect(autoAttentionItems(useStore.getState()).map((item) => item.task)).toContain('t')
    })
  },
)

test('an inactive run without a planner releases its reservation to a background run', async () => {
  load()
  vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
  let finish!: (value: Worktree[]) => void
  vi.mocked(ipc.gitWorktrees).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  setRun({ stage: 'plan', planMark: 'initial' })
  await withFollower(async () => {
    await flush()
    useStore.getState().setActiveTask(null, true)
    useStore.getState().patchTask('p', null, {
      auto: run({
        runId: 'next',
        stage: 'plan',
        background: true,
        merge: { mode: 'ask', destinationBranch: 'feature' },
      }),
    })
    vi.mocked(awaitSessions.startTerminal).mockImplementation(async () => {
      const { plannerSessionId } = await import('../types')
      const sid = plannerSessionId('codex', 'p')
      useStore.setState({ sessions: { [sid]: { running: true, startedMs: Date.now() } } })
      return 'request'
    })
    finish([tree, { ...tree, path: '/p', branch: 'main', current: true }])
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ status: 'paused', pauseKind: 'inactive' })
    expect(awaitSessions.startTerminal).toHaveBeenCalledOnce()
    expect(autoRun('p', null)?.status).toBe('running')
  })
})

test('a paused implementation handoff preserves its plan while blocked runs wait', async () => {
  load()
  setRun({ stage: 'implement', planMark: 'ready', status: 'paused', pauseKind: 'inactive' })
  useStore.getState().setActiveTask(null, true)
  useStore.getState().patchTask('p', null, {
    auto: run({ runId: 'next', stage: 'plan', background: true }),
  })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', null)).toMatchObject({
      status: 'running',
      reason: 'Waiting for the planner',
    })
    expect(awaitSessions.startTerminal).not.toHaveBeenCalled()
  })
})

test.each([false, true])(
  'Start cannot adopt a planner reserved for implementation handoff (background: %s)',
  async (background) => {
    load()
    vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
    useStore.getState().patchTask('p', null, {
      auto: run({ runId: 'owner', stage: 'implement', planMark: 'ready', status: 'paused' }),
    })
    // The owner cleared sessionId when it advanced to Implement, but still holds the shared plan.
    useStore.setState({
      sessionRecords: [plannerRecord()],
      sessions: { s: reviewSession('working', 1500) },
    })
    await startAuto('p', 't', {
      goal: 'Another goal',
      effort: 'light',
      device: 'codex',
      background,
      merge: { mode: 'ask', destinationBranch: 'main' },
    })
    expect(autoRun('p', 't')).toMatchObject({ status: 'running', stage: 'plan' })
    expect(autoRun('p', 't')?.sessionId).toBeUndefined()
  },
)

test('disconnect during a snapshot waits for reconciliation before launching', async () => {
  load()
  let finish!: (value: Worktree[]) => void
  vi.mocked(ipc.gitWorktrees).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  setRun()
  await withFollower(async () => {
    await flush()
    useStore.setState({ serviceConnected: false })
    finish([tree, { ...tree, path: '/p', branch: 'main', current: true }])
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ status: 'running' })
    expect(jobs.startReviewAgent).not.toHaveBeenCalled()
    vi.mocked(jobs.startReviewAgent).mockImplementation(async () => {
      agent('working', 1500)
      return 's'
    })
    useStore.setState({ serviceConnected: true })
    await flush()
    expect(jobs.startReviewAgent).toHaveBeenCalledOnce()
    expect(autoRun('p', 't')).toMatchObject({ status: 'running', sessionId: 's' })
  })
})

test.each(['implement', 'fix'] as const)(
  'a disconnected, unconfirmed %s launch fails and never launches twice on reconnect',
  async (stage) => {
    load()
    const { implementPlannerPlan } = await import('./planHandoff')
    const { fixReviewFindings } = await import('./reviewHandoff')
    const launch = stage === 'implement' ? implementPlannerPlan : fixReviewFindings
    useStore.setState({ sessionRecords: [reviewRecord('reviewer', null, reviewSession('review'))] })
    vi.mocked(launch).mockResolvedValue({ sessionId: 'started', requestId: 'request' })
    vi.mocked(awaitSessions.reconcileFreshSessions).mockImplementation(async () => {
      useStore.setState({ serviceConnected: false })
      throw new Error('Connection lost while confirming the launch')
    })
    setRun({ stage })
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')).toMatchObject({ status: 'failed', pauseKind: undefined })
      useStore.setState({ serviceConnected: true })
      await flush()
      expect(launch).toHaveBeenCalledOnce()
    })
  },
)

test.each([true, false])(
  'a snapshot error pauses as interrupted (service connected: %s)',
  async (connected) => {
    load()
    vi.mocked(ipc.gitWorktrees).mockImplementation(async () => {
      useStore.setState({ serviceConnected: connected })
      throw new Error('Temporary Git or IPC failure')
    })
    setRun()
    await withFollower(async () => {
      await flush()
      expect(autoRun('p', 't')).toMatchObject({ status: 'paused', pauseKind: 'interrupted' })
      expect(jobs.startReviewAgent).not.toHaveBeenCalled()
    })
  },
)

test('disconnect after stopping a completed planner preserves its implementation handoff', async () => {
  load()
  agent('review', 1500)
  vi.mocked(ipc.planRead).mockResolvedValue({ text: '# Finished plan', cut: false })
  setRun({
    stage: 'plan',
    sessionId: 's',
    sessionOwned: true,
    sessionStartedMs: 1000,
    turnSince: 1100,
    planMark: 'old',
    plannerTurn: true,
  })
  vi.mocked(ipc.terminalStop).mockImplementation(async () => {
    useStore.setState({ serviceConnected: false, sessions: {} })
  })
  const { implementPlannerPlan } = await import('./planHandoff')
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      stage: 'implement',
      status: 'running',
      sessionId: undefined,
      plannerTurn: true,
    })
    expect(implementPlannerPlan).not.toHaveBeenCalled()
    vi.mocked(implementPlannerPlan).mockImplementation(async () => {
      useStore.setState({ sessions: { implementation: { running: true, startedMs: 2000 } } })
      return { sessionId: 'implementation', requestId: 'request' }
    })
    useStore.setState({ serviceConnected: true })
    await flush()
    expect(implementPlannerPlan).toHaveBeenCalledOnce()
    expect(autoRun('p', 't')).toMatchObject({
      status: 'running',
      sessionId: 'implementation',
      plannerTurn: false,
    })
  })
})

test('validation finished during a disconnect is saved and never reruns after reconnect', async () => {
  load()
  useStore.getState().addComponent({ x: 0, y: 0 })
  const componentId = useStore.getState().selectedId!
  vi.mocked(ipc.gitReview).mockResolvedValue({
    changes: { [componentId]: [{ path: 'file.txt', kind: 'modified' }] },
    affected: [],
  })
  const report = {
    plan: {
      request: { kind: 'validateChanged' as const, componentIds: [componentId] },
      sessions: ['check'],
      stages: [],
      skipped: [],
      task: 't',
    },
    results: [{ sessionId: 'check', outcome: 'failed' as const, exitCode: 1 }],
  }
  vi.mocked(ipc.graphActionRun).mockImplementation(async () => {
    useStore.setState({ serviceConnected: false })
    return report
  })
  setRun({ stage: 'validate' })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      status: 'running',
      stage: 'review',
      validation: [report],
      validationFindings: expect.stringContaining('[high] Validation failed'),
    })
    expect(jobs.startReviewAgent).not.toHaveBeenCalled()
    vi.mocked(jobs.startReviewAgent).mockImplementation(async () => {
      agent('working', 2000)
      return 's'
    })
    useStore.setState({ serviceConnected: true })
    await flush()
    expect(ipc.graphActionRun).toHaveBeenCalledOnce()
    expect(jobs.startReviewAgent).toHaveBeenCalledOnce()
  })
})

test.each(['user', 'needsUser', 'interrupted', 'restored', 'inactive'] as const)(
  'a %s pause before a planner launches holds no turn',
  async (pauseKind) => {
    load()
    vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
    setRun({ stage: 'plan', status: 'paused', pauseKind, planMark: 'legacy-initial-mark' })
    useStore.getState().setActiveTask(null, true)
    await startAuto('p', null, {
      ...run({ stage: 'plan' }),
      background: true,
      goal: 'Next task',
      merge: { mode: 'ask', destinationBranch: 'feature' },
    })
    expect(autoRun('p', null)?.planMark).toBeUndefined()
    vi.mocked(awaitSessions.startTerminal).mockImplementation(async () => {
      const { plannerSessionId } = await import('../types')
      useStore.setState({
        sessions: { [plannerSessionId('codex', 'p')]: { running: true, startedMs: 2000 } },
      })
      return 'request'
    })
    await withFollower(async () => {
      await flush()
      expect(awaitSessions.startTerminal).toHaveBeenCalledOnce()
      expect(autoRun('p', null)).toMatchObject({ status: 'running', plannerTurn: true })
    })
  },
)

test('restoring and resuming a handoff keeps its turn ahead of a later run, which continues automatically', async () => {
  load()
  vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
  vi.mocked(ipc.planRead).mockResolvedValue({ text: '# Owner plan', cut: false })
  const { restoredAuto } = await import('./autoRestore')
  useStore.getState().patchTask('p', 't', {
    auto: restoredAuto(
      run({ stage: 'implement', background: true, plannerTurn: true, planMark: 'owner' }),
    )!,
  })
  useStore.getState().setActiveTask(null, true)
  useStore.getState().patchTask('p', null, {
    auto: run({
      runId: 'later',
      stage: 'plan',
      background: true,
      planMark: 'initial',
      plannerTurn: false,
      merge: { mode: 'ask', destinationBranch: 'feature' },
    }),
  })
  const { implementPlannerPlan } = await import('./planHandoff')
  let finish!: () => void
  vi.mocked(implementPlannerPlan).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => {
          useStore.setState({ sessions: { implementation: { running: true, startedMs: 2000 } } })
          resolve({ sessionId: 'implementation', requestId: 'request' })
        }
      }),
  )
  vi.mocked(awaitSessions.startTerminal).mockImplementation(async () => {
    const { plannerSessionId } = await import('../types')
    useStore.setState({
      sessions: {
        ...useStore.getState().sessions,
        [plannerSessionId('codex', 'p')]: { running: true, startedMs: 3000 },
      },
    })
    return 'request'
  })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', null)).toMatchObject({
      status: 'running',
      reason: 'Waiting for the planner',
    })
    await resumeAuto('p', 't')
    expect(autoRun('p', 't')?.runId).not.toBe('run')
    expect(autoRun('p', 't')?.plannerTurn).toBe(true)
    await flush()
    expect(implementPlannerPlan).toHaveBeenCalledOnce()
    expect(awaitSessions.startTerminal).not.toHaveBeenCalled()
    finish()
    await flush()
    expect(awaitSessions.startTerminal).toHaveBeenCalledOnce()
    expect(autoRun('p', null)).toMatchObject({ status: 'running', plannerTurn: true })
  })
})

test.each([
  [false, false, 'follow'],
  [false, true, 'stay'],
  [true, false, 'stay'],
  [true, true, 'stay'],
] as const)(
  'fix presentation for background %s and Simple %s is %s',
  async (background, simpleMode, presentation) => {
    load()
    useStore.setState({
      simpleMode,
      sessionRecords: [reviewRecord('reviewer', null, reviewSession('review'))],
    })
    const { fixReviewFindings } = await import('./reviewHandoff')
    vi.mocked(fixReviewFindings).mockImplementation(async () => {
      agent('working', 2000)
      return { sessionId: 's', requestId: 'request' }
    })
    setRun({ stage: 'fix', background })
    await withFollower(async () => {
      await flush()
      expect(vi.mocked(fixReviewFindings).mock.calls[0][3]).toBe(presentation)
    })
  },
)

test('a refused planner launch acquires no turn or plan fingerprint', async () => {
  load()
  vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
  vi.mocked(awaitSessions.startTerminal).mockRejectedValue(new Error(TERMINAL_RUNNING))
  setRun({ stage: 'plan' })
  await withFollower(async () => {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      status: 'paused',
      pauseKind: 'needsUser',
      plannerTurn: false,
      planMark: undefined,
    })
  })
})
