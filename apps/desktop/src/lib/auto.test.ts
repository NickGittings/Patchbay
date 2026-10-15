import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import type { AutoRun, ReviewFindings, SessionState, Worktree } from '../types'
vi.mock('./ipc', () => ({
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
vi.mock('./reviewAgents', async () => ({
  ...(await vi.importActual<typeof import('./reviewAgents')>('./reviewAgents')),
  startReviewAgent: vi.fn(),
  startMergeAgent: vi.fn(),
}))
const {
  inferStage,
  nextStep,
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
  editedSinceStart: false,
  truncated: false,
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
  expect(
    nextStep(run(), {
      ...findings(),
      verdict: { clean: false, counts: { critical: 0, high: 0, medium: 0, low: 0 } },
    }).status,
  ).toBe('paused')
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
  })
  useStore.getState().setActiveTask('t')
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
  const stop = followAuto()
  try {
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
  } finally {
    stop()
  }
})
test('needs input resumes only on authoritative work; interruption pauses', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  useStore.getState().patchTask('p', 't', { auto: run({ sessionId: 's', turnSince: 1000 }) })
  const stop = followAuto()
  try {
    agent('needsInput', 1100)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('waitingOnYou')
    agent('working', 1200, false)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('waitingOnYou')
    agent('working', 1300)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('running')
    agent('idle', 1400)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('paused')
  } finally {
    stop()
  }
})
test('inactive worktrees pause and manual changes are picked up on resume', async () => {
  vi.useFakeTimers()
  load()
  useStore.getState().patchTask('p', 't', { auto: run({ effort: 'light' }) })
  useStore.getState().setActiveTask(null, true)
  const stop = followAuto()
  try {
    await flush()
    expect(autoRun('p', 't')?.status).toBe('paused')
    expect(useStore.getState().auto).toBeNull()
    expect(jobs.startReviewAgent).not.toHaveBeenCalled()
    pauseAuto('p', 't')
    vi.mocked(ipc.reviewRead).mockResolvedValue(findings({ high: 1 }))
    useStore.getState().setActiveTask('t')
    await resumeAuto('p', 't')
    expect(autoRun('p', 't')?.stage).toBe('fix')
  } finally {
    stop()
  }
})
test('skipping review still requires explicit merge approval', () => {
  load()
  useStore.getState().patchTask('p', 't', {
    auto: run({ status: 'paused', merge: { mode: 'auto', destinationBranch: 'main' } }),
  })
  skipStage('p', 't')
  expect(autoRun('p', 't')).toMatchObject({ stage: 'mergeGate', status: 'waitingOnYou' })
})

test('a task description launches Plan with the goal and then hands off its saved plan', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
  const { startTerminal } = await import('./sessions')
  const { implementPlannerPlan } = await import('./planHandoff')
  vi.mocked(startTerminal).mockImplementation(async () => {
    const { plannerSessionId } = await import('../types')
    const sid = plannerSessionId('codex', 'p')
    useStore.setState({ sessions: { [sid]: { running: true, startedMs: 1000 } } })
  })
  vi.mocked(implementPlannerPlan).mockResolvedValue('implementation')
  const stop = followAuto()
  try {
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
    )
  } finally {
    stop()
  }
})

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
  const stop = followAuto()
  try {
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
  } finally {
    stop()
  }
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
  useStore.getState().patchTask('p', 't', {
    auto: run({ status: 'paused', stage: 'fix', sessionId: 's', sessionOwned: true }),
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
  useStore.getState().patchTask('p', 't', { auto: run({ sessionId: 's', turnSince: 1000 }) })
  const stop = followAuto()
  try {
    agent('idle', 1100)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('running')
    agent('working', 1200)
    await flush()
    agent('idle', 1300, false)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('paused')
  } finally {
    stop()
  }
})

test('denying an agent prompt pauses even when no provider hook confirms the denial', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  useStore.getState().patchTask('p', 't', { auto: run({ sessionId: 's', turnSince: 1000 }) })
  const stop = followAuto()
  try {
    agent('needsInput', 1100)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('waitingOnYou')
    agent('idle', 1200, false)
    await flush()
    expect(autoRun('p', 't')?.status).toBe('paused')
  } finally {
    stop()
  }
})

test('service-side forgetting pauses the run instead of waiting forever for a removed session', async () => {
  vi.useFakeTimers()
  load()
  useStore.setState({ serviceConnected: true, sessionRecords: [], sessions: {} })
  useStore.getState().patchTask('p', 't', { auto: run({ sessionId: 'forgotten' }) })
  const stop = followAuto()
  try {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      status: 'paused',
      reason: 'The tracked session was forgotten',
    })
  } finally {
    stop()
  }
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
  const stop = followAuto()
  try {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ stage: 'mergeGate', status: 'waitingOnYou' })
    expect(jobs.startMergeAgent).not.toHaveBeenCalled()
  } finally {
    stop()
  }
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
  useStore.getState().patchTask('p', 't', { auto: run({ stage: 'validate', status: 'paused' }) })
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
  useStore.getState().patchTask('p', 't', {
    auto: run({ status: 'paused', reviewedHead: 'before-fix' }),
  })
  await skipStage('p', 't')
  expect(autoRun('p', 't')).toMatchObject({ stage: 'mergeGate', reviewedHead: undefined })
  const dispose = followAuto()
  try {
    mergeNow('p', 't')
    await flush()
    expect(jobs.startMergeAgent).toHaveBeenCalledTimes(1)
    expect(autoRun('p', 't')?.status).toBe('running')
  } finally {
    dispose()
  }
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
      useStore.getState().patchTask('p', 't', { auto: run({ effort: 'light', status: 'paused' }) })
      await resumeAuto('p', 't')
    }
    expect(autoRun('p', 't')?.sessionId).toBe('s')
    stopAuto('p', 't')
    expect(ipc.terminalStop).not.toHaveBeenCalled()
    await resumeAuto('p', 't')
    const dispose = followAuto()
    try {
      agent('review', 1200)
      await flush()
      expect(jobs.startReviewAgent).toHaveBeenCalledTimes(1)
      expect(ipc.terminalStop).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
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
  useStore.getState().patchTask('p', 't', {
    auto: run({ sessionId: 's', sessionOwned: true, sessionStartedMs: 900 }),
  })
  stopAuto('p', 't')
  expect(ipc.terminalStop).not.toHaveBeenCalled()
})

test('resuming preserves ownership only for the same Auto-launched generation', async () => {
  load()
  manualAgent()
  useStore.getState().patchTask('p', 't', {
    auto: run({ status: 'paused', sessionId: 's', sessionOwned: true, sessionStartedMs: 1000 }),
  })
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
  useStore.getState().patchTask('p', 't', {
    auto: run({ sessionId: 's', sessionOwned: true, turnSince: 1000, launchAtMs: 1000 }),
  })
  const dispose = followAuto()
  try {
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
  } finally {
    dispose()
  }
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
  const dispose = followAuto()
  try {
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
  } finally {
    dispose()
  }
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

test('needsInput can go directly to review without an observed working tick', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  load()
  vi.mocked(ipc.reviewRead).mockResolvedValue(findings())
  useStore.getState().patchTask('p', 't', { auto: run({ sessionId: 's', turnSince: 1000 }) })
  const stop = followAuto()
  try {
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
  } finally {
    stop()
  }
})

function plannerRecord() {
  return {
    id: 's',
    metadata: { projectId: 'p', componentId: '@plan', kind: 'agent' },
    spec: { cwd: '/p', command: 'codex' },
  } as unknown as import('../types').SessionRecord
}

test.each(['running', 'paused', 'waitingOnYou'] as const)(
  'Resume cannot take another %s run’s planner',
  async (status) => {
    load()
    useStore
      .getState()
      .patchTask('p', null, { auto: run({ stage: 'plan', sessionId: 's', status }) })
    useStore
      .getState()
      .patchTask('p', 't', { auto: run({ runId: 'second', stage: 'plan', status: 'paused' }) })
    useStore.setState({ sessionRecords: [plannerRecord()] })
    agent('working', 1000)
    await expect(resumeAuto('p', 't')).rejects.toThrow('already belongs to another Auto run')
    expect(autoRun('p', 't')).toMatchObject({
      runId: 'second',
      status: 'paused',
    })
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
  vi.mocked(implementPlannerPlan).mockResolvedValue('implementation')
  agent('review', 1200)
  const stop = followAuto()
  try {
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    expect(ipc.terminalStop).toHaveBeenCalledWith('s')
    expect(implementPlannerPlan).toHaveBeenCalledOnce()
    expect(vi.mocked(ipc.terminalStop).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(implementPlannerPlan).mock.invocationCallOrder[0],
    )
  } finally {
    stop()
  }
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

test('Auto refuses an unconfirmed launch without recording a phantom session', async () => {
  load()
  vi.mocked(awaitSessions.reconcileFreshSessions).mockResolvedValue(undefined)
  useStore.getState().patchTask('p', 't', { auto: run({ stage: 'merge' }) })
  const stop = followAuto()
  try {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ status: 'failed' })
    expect(autoRun('p', 't')?.sessionId).toBeUndefined()
    expect(autoRun('p', 't')?.reason).toContain('launch was not confirmed')
  } finally {
    stop()
  }
})

test('shared planner is reserved while a launch is pending without session records', async () => {
  vi.useFakeTimers()
  load()
  vi.mocked(ipc.gitReview).mockResolvedValue({ changes: {}, affected: [] })
  let finish!: () => void
  vi.mocked(awaitSessions.startTerminal).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  useStore.getState().patchTask('p', 't', { auto: run({ stage: 'plan' }) })
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
    expect(autoRun('p', null)?.reason).toContain('already belongs to another Auto run')
  } finally {
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
  useStore.getState().patchTask('p', 't', {
    auto: run({ stage: 'merge', sessionId: 's', sessionOwned: true, turnSince: 1000 }),
  })
  const stop = followAuto()
  try {
    agent('review', 1100)
    await flush()
    expect(autoRun('p', 't')).toMatchObject({
      stage: 'merge',
      status: 'waitingOnYou',
      sessionId: 's',
    })
    expect(ipc.terminalStop).not.toHaveBeenCalled()
  } finally {
    stop()
  }
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
  useStore.getState().patchTask('p', 't', { auto: run({ stage: 'validate' }) })
  const stop = followAuto()
  try {
    await flush()
    expect(autoRun('p', 't')).toMatchObject({ stage: 'validate', status: 'paused' })
    expect(autoRun('p', 't')?.reason).toContain('Another graph action is still running')
    expect(useStore.getState().graphAction).toBeNull()
    expect(useStore.getState().graphActionBusy).toBe(false)
  } finally {
    stop()
  }
})

test('skipping a fix whose budget ran out goes to the merge gate', async () => {
  load()
  useStore.getState().patchTask('p', 't', {
    auto: run({ stage: 'fix', status: 'waitingOnYou', round: 1 }),
  })
  await skipStage('p', 't')
  expect(autoRun('p', 't')).toMatchObject({ stage: 'mergeGate', status: 'waitingOnYou' })
  useStore.getState().patchTask('p', 't', {
    auto: run({ stage: 'fix', status: 'paused', sessionId: 'gone' }),
  })
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
  const stop = followAuto()
  try {
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
  } finally {
    stop()
  }
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
