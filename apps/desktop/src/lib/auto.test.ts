import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import type { AutoRun, ReviewFindings, SessionState, Worktree } from '../types'
vi.mock('./ipc', () => ({
  agentHooksCheck: vi.fn(),
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
vi.mock('./sessions', () => ({ startTerminal: vi.fn(), reconcileFreshSessions: vi.fn() }))
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
  actionSucceeded,
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
  ['plan only', { plan: '# Plan' }, 'implement', 'running'],
  ['proposal only', { proposal: true }, 'implement', 'running'],
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
  const report = {
    plan: {
      request: { kind: 'validateAffected' as const, componentId: 'a' },
      stages: [],
      skipped: [],
      sessions: [],
      task: null,
    },
    results: [],
  }
  expect(actionSucceeded(report)).toBe(true)
  expect(actionSucceeded({ ...report, plan: { ...report.plan, skipped: ['a'] } })).toBe(true)
  expect(
    actionSucceeded({
      ...report,
      results: [{ sessionId: 's', outcome: 'cancelled', exitCode: null }],
    }),
  ).toBe(false)
})
function load() {
  vi.mocked(jobs.startMergeAgent).mockResolvedValue('merge-s')
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
    expect(startTerminal).toHaveBeenCalledWith(
      '@plan',
      'codex',
      't',
      'p',
      'plan',
      expect.objectContaining({ goal: 'Implement the description', commit: false }),
    )
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
      { kind: 'validateAffected', componentId: id },
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
  useStore
    .getState()
    .patchTask('p', 't', { auto: run({ status: 'paused', stage: 'fix', sessionId: 's' }) })
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
