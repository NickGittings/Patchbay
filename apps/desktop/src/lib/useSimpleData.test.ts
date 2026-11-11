import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import * as ipc from './ipc'
import { useSimpleData } from './useSimpleData'

const h = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  effects: [] as { deps: unknown[]; cleanup?: () => void }[],
  effectCursor: 0,
  savedBase: 'release',
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const i = h.cursor++
    if (!(i in h.states)) h.states[i] = initial
    return [h.states[i], (value: unknown) => (h.states[i] = value)]
  },
  useMemo: (fn: () => unknown) => fn(),
  useEffect: (fn: () => (() => void) | undefined, deps: unknown[]) => {
    const i = h.effectCursor++
    const previous = h.effects[i]
    if (previous && deps.every((d, n) => d === previous.deps[n])) return
    previous?.cleanup?.()
    h.effects[i] = { deps, cleanup: fn() }
  },
}))
vi.mock('../store', async (original) => {
  const actual = await original<typeof import('../store')>()
  return {
    ...actual,
    useStore: Object.assign(
      (select: (s: ReturnType<typeof actual.useStore.getState>) => unknown) =>
        select(actual.useStore.getState()),
      actual.useStore,
    ),
  }
})
vi.mock('./useReviewFindings', () => ({
  useReviewFindings: (_project: string, branch?: string) =>
    branch ? { findings: { base: h.savedBase } } : undefined,
}))
vi.mock('./sessions', () => ({ listenForTerminals: vi.fn(), reconcileFreshSessions: vi.fn() }))
vi.mock('./ipc', () => ({
  gitReview: vi.fn(),
  gitWorktrees: vi.fn(),
  gitBranches: vi.fn(),
  planRead: vi.fn(),
  proposalRead: vi.fn(),
  mergeOutcome: vi.fn(),
  onProposal: vi.fn(async () => () => {}),
}))

function Reader() {
  return useSimpleData(true)
}

function render() {
  h.cursor = 0
  h.effectCursor = 0
  return Reader()
}

async function settle() {
  // The reader waits for plans, metadata, changes, then the optional merge outcome.
  await vi.waitFor(() => expect(render().data).toBeDefined())
  return render()
}

beforeEach(() => {
  h.states = []
  h.effects = []
  h.savedBase = 'release'
  vi.clearAllMocks()
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  useStore.setState(useStore.getInitialState())
  useStore.setState({ project: { id: 'p', name: 'p', root: '/repo' } })
  vi.mocked(ipc.gitWorktrees).mockResolvedValue([
    { path: '/repo', branch: 'feature', head: 'abc', current: true, main: true },
  ])
  vi.mocked(ipc.gitBranches).mockResolvedValue(['feature', 'main', 'release'])
  vi.mocked(ipc.planRead).mockResolvedValue({ text: 'plan', cut: false, savedMs: 1 })
  vi.mocked(ipc.proposalRead).mockResolvedValue(null)
  vi.mocked(ipc.gitReview).mockImplementation(async (_project, _worktree, base) => {
    if (base && !(await ipc.gitBranches('p')).includes(base)) throw new Error('unknown base')
    return { ahead: true, changes: {}, affected: [] }
  })
})

afterEach(() => {
  h.effects.forEach((e) => e.cleanup?.())
  vi.unstubAllGlobals()
})

test('a deleted saved base falls back and continues exposing artifacts on refresh', async () => {
  const request = {
    source: '/repo',
    sourceBranch: 'feature',
    destination: '/main',
    destinationBranch: 'main',
  }
  useStore.setState({
    simple: {
      startedMs: 1,
      log: [{ id: 'merge', atMs: 1, stage: 'merge', kind: 'action', action: 'merge', request }],
    },
  })
  vi.mocked(ipc.mergeOutcome).mockResolvedValue('notMerged')
  render()
  expect((await settle()).base).toBe('release')

  vi.mocked(ipc.gitBranches).mockResolvedValue(['feature', 'main'])
  vi.mocked(ipc.planRead).mockResolvedValue({ text: 'updated plan', cut: false, savedMs: 2 })
  vi.mocked(ipc.proposalRead).mockResolvedValue({ version: 1, plan: 'proposal', assignments: [] })
  vi.mocked(ipc.mergeOutcome).mockResolvedValue('merged')
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(render().base).toBe('main'))
  const reader = render()
  expect(reader.error).toBe('')
  expect(reader.data?.plan.text).toBe('updated plan')
  expect(reader.data?.proposal?.plan).toBe('proposal')
  expect(reader.data?.outcome).toBe('merged')
  expect(reader.data?.review.ahead).toBe(true)
  expect(ipc.gitReview).toHaveBeenLastCalledWith(expect.anything(), undefined, 'main')
})

test('an unavailable saved base uses an uncommitted comparison when no default exists', async () => {
  vi.mocked(ipc.gitBranches).mockResolvedValue(['feature'])
  render()
  const reader = await settle()
  expect(reader.base).toBeUndefined()
  expect(reader.error).toBe('')
  expect(reader.data?.plan.text).toBe('plan')
  expect(ipc.gitReview).toHaveBeenLastCalledWith(expect.anything(), undefined, undefined)
})

test('a project outside Git still loads plans and changes from its component repositories', async () => {
  vi.mocked(ipc.gitWorktrees).mockResolvedValue([])
  vi.mocked(ipc.gitBranches).mockRejectedValue(new Error("The project isn't in a git repo"))
  vi.mocked(ipc.gitReview).mockResolvedValue({
    ahead: false,
    changes: { app: [{ path: 'app/file', kind: 'modified' }] },
    affected: [],
  })
  render()
  const reader = await settle()
  expect(reader.error).toBe('')
  expect(reader.base).toBeUndefined()
  expect(reader.data?.plan.text).toBe('plan')
  expect(reader.data?.review.changes.app).toHaveLength(1)
  expect(ipc.gitBranches).not.toHaveBeenCalled()
})
