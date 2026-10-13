import { beforeEach, expect, test, vi } from 'vitest'
import {
  MERGE_SCOPE,
  REVIEW_SCOPE,
  type AgentState,
  type Task,
  type ReviewFindings,
  type DeviceManifest,
  type Project,
  type SessionRecord,
  type Worktree,
} from '../types'

vi.mock('./ipc', () => ({ mergeAgentStart: vi.fn(), reviewAgentStart: vi.fn() }))
vi.mock('./sessions', () => ({ listenForTerminals: vi.fn(), reconcileFreshSessions: vi.fn() }))
const { mergeAgentStart, reviewAgentStart } = await import('./ipc')
const { listenForTerminals, reconcileFreshSessions } = await import('./sessions')
const { defaultMergeDestination, mergeDestinations, reviewAgentRecords, startMergeAgent } =
  await import('./reviewAgents')
const tree = (path: string, branch: string | undefined, current = false): Worktree => ({
  path,
  branch,
  current,
  main: current,
  head: 'abc',
})
const source = tree('/feature', 'feature')

beforeEach(() => vi.resetAllMocks())

test('destinations exclude the source, matching branch, and detached worktrees', () => {
  const trees = [
    source,
    tree('/same', 'feature'),
    tree('/detached', undefined),
    tree('/main', 'main', true),
  ]
  expect(mergeDestinations(source, trees).map((w) => w.path)).toEqual(['/main'])
  expect(defaultMergeDestination(source, trees)).toBe('/main')
})

test('reviewing the open worktree requires an explicit destination choice', () => {
  const main = tree('/main', 'main', true)
  expect(defaultMergeDestination(main, [main, source])).toBe('')
  expect(defaultMergeDestination(source, [source, tree('/other', 'other')])).toBe('')
})

const record = (id: string, projectId: string, componentId: string, startedMs: number) =>
  ({
    id,
    metadata: { projectId, componentId },
    snapshot: { startedMs },
    history: [],
  }) as unknown as SessionRecord

test('merge sessions recover across view remounts and stay in their own project', () => {
  const records = [
    record('old', 'p', MERGE_SCOPE, 10),
    record('other-project', 'q', MERGE_SCOPE, 40),
    record('implementation', 'p', '@task', 50),
    record('new', 'p', MERGE_SCOPE, 30),
  ]
  expect(reviewAgentRecords(records, 'p').map((r) => r.id)).toEqual(['new', 'old'])
  expect(records[0].id).toBe('old')
})

test('launch uses the captured project and whole branch request, subscribes first, then recovers the record', async () => {
  const project = { projectId: 'captured-project' } as Project
  const request = {
    source: '/feature',
    sourceBranch: 'feature',
    destination: '/main',
    destinationBranch: 'main',
  }
  const device: DeviceManifest = {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    kind: 'agent',
    adapter: 'codex',
    category: 'agent',
    source: 'builtin',
  }
  vi.mocked(mergeAgentStart).mockResolvedValue('sid')
  expect(await startMergeAgent(project, request, device, 'request-id')).toBe('sid')
  expect(mergeAgentStart).toHaveBeenCalledWith(
    project,
    request,
    {
      id: 'codex',
      name: 'Codex',
      command: 'codex',
      kind: 'agent',
      adapter: 'codex',
    },
    'request-id',
  )
  expect(vi.mocked(listenForTerminals).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(mergeAgentStart).mock.invocationCallOrder[0],
  )
  expect(vi.mocked(reconcileFreshSessions).mock.invocationCallOrder[0]).toBeGreaterThan(
    vi.mocked(mergeAgentStart).mock.invocationCallOrder[0],
  )
})

test('launch errors reach the dialog without reporting a successful session', async () => {
  vi.mocked(mergeAgentStart).mockRejectedValue(new Error('source worktree has uncommitted changes'))
  await expect(
    startMergeAgent(
      { projectId: 'p' } as Project,
      {
        source: '/feature',
        sourceBranch: 'feature',
        destination: '/main',
        destinationBranch: 'main',
      },
      {
        id: 'codex',
        name: 'Codex',
        command: 'codex',
        kind: 'agent',
        category: 'agent',
        source: 'builtin',
      },
      'request',
    ),
  ).rejects.toThrow('uncommitted changes')
  expect(reconcileFreshSessions).not.toHaveBeenCalled()
})

test('merge runtime terminals do not enter the implementation task grid', async () => {
  const { taskTerminals } = await import('./taskTerminals')
  expect(
    taskTerminals(
      { rootTerminals: [], componentTerminals: [] },
      [],
      {
        merge: {
          projectId: 'p',
          taskId: null,
          componentId: MERGE_SCOPE,
          terminal: { id: 'merge', name: 'Merge', kind: 'agent', command: 'codex' },
        },
      },
      'p',
      null,
      { merge: { running: true } },
    ),
  ).toEqual([])
})

test('a stop event allows another merge despite an older running record snapshot', async () => {
  const { mergeDestinationRunning } = await import('./reviewAgents')
  const r = {
    ...record('merge', 'p', MERGE_SCOPE, 10),
    spec: { cwd: '/main' },
    snapshot: { running: true },
  } as SessionRecord
  expect(mergeDestinationRunning([r], {}, '/main')).toBe(true)
  expect(mergeDestinationRunning([r], { merge: { running: false } }, '/main')).toBe(false)
  expect(mergeDestinationRunning([r], { merge: { running: true } }, '/other')).toBe(false)
})

test('Review automatically selects only running merges and permits explicit finished selection', async () => {
  const { currentReviewAgentRecord } = await import('./reviewAgents')
  const done = {
    ...record('done', 'p', MERGE_SCOPE, 20),
    snapshot: { running: false },
  } as SessionRecord
  const running = {
    ...record('running', 'p', MERGE_SCOPE, 10),
    snapshot: { running: true },
  } as SessionRecord
  expect(currentReviewAgentRecord([done], {}, undefined)).toBeUndefined()
  expect(currentReviewAgentRecord([done, running], {}, undefined)).toBe(running)
  expect(
    currentReviewAgentRecord([done, running], { running: { running: false } }, undefined),
  ).toBeUndefined()
  expect(currentReviewAgentRecord([done], {}, 'done')).toBe(done)
})

test('review base prefers the matching task base then the open branch', async () => {
  const { defaultReviewBase } = await import('./reviewAgents')
  const task = { worktree: '/feature', base: 'release' } as Task
  expect(defaultReviewBase(source, [task], [tree('/main', 'main', true)])).toBe('release')
  expect(defaultReviewBase(source, [], [tree('/main', 'main', true)])).toBe('main')
  expect(
    defaultReviewBase(source, [{ ...task, missing: true }], [tree('/main', 'main', true)]),
  ).toBe('main')
  expect(defaultReviewBase(source, [], [])).toBe('')
})

test('local branches supply bases when no worktree or task names one', async () => {
  const { defaultReviewBase, reviewBases } = await import('./reviewAgents')
  const open = { ...source, current: true }
  const branches = ['feature', 'main', 'topic']
  expect(reviewBases(open, [], [open], branches)).toEqual(['main', 'topic'])
  expect(defaultReviewBase(open, [], [open], branches)).toBe('main')
  expect(defaultReviewBase(open, [], [open], ['feature', 'master'])).toBe('master')
  expect(defaultReviewBase(open, [], [open], ['feature', 'topic'])).toBe('')
})

test('a branch is never its own review base', async () => {
  const { defaultReviewBase, reviewBases } = await import('./reviewAgents')
  const open = { ...source, current: true }
  expect(defaultReviewBase(open, [], [open])).toBe('')
  const own = { worktree: source.path, base: source.branch } as Task
  expect(defaultReviewBase(source, [own], [tree('/main', 'main', true)])).toBe('main')
  expect(
    reviewBases(open, [{ base: 'release' } as Task], [open, tree('/main', 'main', false)]),
  ).toEqual(['main', 'release'])
})

test('findings become stale for new HEADs, newer edits and unfinished review attempts', async () => {
  const { reviewState } = await import('./reviewAgents')
  const findings: ReviewFindings = {
    text: 'No findings',
    modifiedMs: 100,
    reviewedHead: 'abc',
    base: 'main',
    startedMs: 40,
    editedSinceStart: false,
    truncated: false,
  }
  expect(reviewState(null, source)).toBe('none')
  expect(reviewState(findings, source)).toBe('current')
  // Edited while the agent was reviewing, or after: the backend checks the whole worktree.
  expect(reviewState({ ...findings, editedSinceStart: true }, source)).toBe('stale')
  expect(reviewState(findings, { ...source, head: 'def' })).toBe('stale')
  expect(reviewState({ ...findings, reviewedHead: null }, source)).toBe('stale')
})

test('both job scopes recover together with explicit finished selection', async () => {
  const { currentReviewAgentRecord } = await import('./reviewAgents')
  const review = {
    ...record('review', 'p', REVIEW_SCOPE, 30),
    snapshot: { running: false, startedMs: 30 },
  } as SessionRecord
  const merge = {
    ...record('merge', 'p', MERGE_SCOPE, 10),
    snapshot: { running: true, startedMs: 10 },
  } as SessionRecord
  const records = reviewAgentRecords([merge, review, record('foreign', 'q', REVIEW_SCOPE, 40)], 'p')
  expect(records.map((r) => r.id)).toEqual(['review', 'merge'])
  expect(currentReviewAgentRecord(records, {}, undefined)).toBe(merge)
  expect(currentReviewAgentRecord(records, {}, 'review')).toBe(review)
})

test('review launch subscribes first and reconciles only successful starts', async () => {
  const { startReviewAgent } = await import('./reviewAgents')
  const project = { projectId: 'captured' } as Project
  const request = { worktree: '/feature', branch: 'feature', base: 'main' }
  const device = {
    id: 'claude',
    name: 'Claude',
    command: 'claude',
    adapter: 'claude',
  } as DeviceManifest
  vi.mocked(reviewAgentStart).mockResolvedValue('review')
  expect(await startReviewAgent(project, request, device, 'request')).toBe('review')
  expect(reviewAgentStart).toHaveBeenCalledWith(
    project,
    request,
    { id: 'claude', name: 'Claude', command: 'claude', adapter: 'claude', kind: 'agent' },
    'request',
  )
  expect(vi.mocked(listenForTerminals).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(reviewAgentStart).mock.invocationCallOrder[0],
  )
  expect(vi.mocked(reconcileFreshSessions).mock.invocationCallOrder[0]).toBeGreaterThan(
    vi.mocked(reviewAgentStart).mock.invocationCallOrder[0],
  )
  vi.mocked(reviewAgentStart).mockRejectedValue(new Error('Unknown review base'))
  await expect(startReviewAgent(project, request, device, 'next')).rejects.toThrow(
    'Unknown review base',
  )
  expect(reconcileFreshSessions).toHaveBeenCalledTimes(1)
})

test('only a live review in the same worktree blocks another review', async () => {
  const { reviewWorktreeRunning } = await import('./reviewAgents')
  const review = {
    ...record('review', 'p', REVIEW_SCOPE, 10),
    spec: { cwd: '/feature' },
    snapshot: { running: true },
  } as SessionRecord
  const merge = { ...review, metadata: { ...review.metadata, componentId: MERGE_SCOPE } }
  expect(reviewWorktreeRunning([merge], {}, '/feature')).toBe(false)
  expect(reviewWorktreeRunning([review], {}, '/feature')).toBe(true)
  expect(reviewWorktreeRunning([review], {}, '/other')).toBe(false)
  expect(reviewWorktreeRunning([review], { review: { running: false } }, '/feature')).toBe(false)
})

test('only a review that reported or confirmed settling stops blocking the fix handoff', async () => {
  const { reviewWorktreeBusy } = await import('./reviewAgents')
  const review = {
    ...record('review', 'p', REVIEW_SCOPE, 10),
    spec: { cwd: '/feature' },
    snapshot: { running: true },
  } as SessionRecord
  const status = (
    active: boolean,
    agent?: AgentState,
    authoritative = true,
    lastOutputMs: number | null = null,
  ) => ({
    review: {
      running: true,
      status: {
        lastOutputMs,
        active,
        agent: agent
          ? { state: agent, sinceMs: 0, message: null, prompt: null, authoritative }
          : null,
        url: null,
        ready: false,
        healthy: null,
        stopped: false,
        seenMs: null,
      },
    },
  })
  expect(reviewWorktreeBusy([review], {}, '/feature')).toBe(true)
  expect(reviewWorktreeBusy([review], status(true), '/feature')).toBe(true)
  // Quiet without hooks may be thinking; the reviewer must exit.
  expect(reviewWorktreeBusy([review], status(false), '/feature')).toBe(true)
  expect(reviewWorktreeBusy([review], status(false, 'working'), '/feature')).toBe(true)
  // A permission prompt may lead to more writing.
  expect(reviewWorktreeBusy([review], status(false, 'needsInput'), '/feature')).toBe(true)
  // An unconfirmed or self-reported idle may be a stale report or an interrupt.
  expect(reviewWorktreeBusy([review], status(false, 'idle', false), '/feature')).toBe(true)
  expect(reviewWorktreeBusy([review], status(true, 'idle'), '/feature')).toBe(false)
  expect(reviewWorktreeBusy([review], status(false, 'review'), '/feature')).toBe(false)
  // The end of a turn is always reported, never inferred.
  expect(reviewWorktreeBusy([review], status(false, 'review', false), '/feature')).toBe(false)
  // Output well after a self-reported end of turn is a follow-up turn; hooks would report it.
  expect(reviewWorktreeBusy([review], status(false, 'review', false, 1000), '/feature')).toBe(false)
  expect(reviewWorktreeBusy([review], status(false, 'review', false, 5000), '/feature')).toBe(true)
  expect(reviewWorktreeBusy([review], status(false, 'review', true, 5000), '/feature')).toBe(false)
  expect(reviewWorktreeBusy([review], status(false, 'working'), '/other')).toBe(false)
  expect(reviewWorktreeBusy([review], { review: { running: false } }, '/feature')).toBe(false)
})

test('review scope belongs in Review and never in the implementation grid or dock', async () => {
  const { isReservedScope, isReviewAgentScope, showsInDock, sessionView } = await import('../types')
  expect(isReservedScope(REVIEW_SCOPE)).toBe(true)
  expect(isReviewAgentScope(REVIEW_SCOPE)).toBe(true)
  expect(isReviewAgentScope(MERGE_SCOPE)).toBe(true)
  expect(showsInDock(REVIEW_SCOPE)).toBe(false)
  expect(sessionView(REVIEW_SCOPE)).toBe('review')
  const { taskTerminals } = await import('./taskTerminals')
  expect(
    taskTerminals(
      { rootTerminals: [], componentTerminals: [] },
      [],
      {
        review: {
          projectId: 'p',
          taskId: null,
          componentId: REVIEW_SCOPE,
          terminal: { id: 'review', name: 'Review', kind: 'agent', command: 'claude' },
        },
      },
      'p',
      null,
      { review: { running: true } },
    ),
  ).toEqual([])
})
