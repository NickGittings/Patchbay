import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import {
  cleanupJobs,
  cleanupCurrent,
  retireTaskCleanup,
  deleteMergedWork,
  handledCleanup,
  readyCleanup,
  trackMergeCleanup,
} from './mergeCleanup'
import { gitWorktrees, mergeCleanup, mergeCleanupPreview, mergeOutcome } from './ipc'
import { forgetMainWorktree, refreshMainWorktree, useMainWorktree } from './mainWorktree'
import type { Project } from '../types'

vi.mock('./ipc', () => ({
  mergeOutcome: vi.fn(),
  mergeCleanup: vi.fn(),
  mergeCleanupPreview: vi.fn(),
  gitWorktrees: vi.fn(),
}))
vi.mock('./sessions', () => ({ reconcileFreshSessions: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./tasks', () => ({ refreshTasks: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./git', () => ({ requestGitRefresh: vi.fn().mockResolvedValue(undefined) }))

const project: Project = {
  schemaVersion: 4,
  projectId: 'p',
  name: 'P',
  root: '/p',
  components: [],
  links: [],
  groups: [],
}
const request = {
  source: '/feature',
  sourceBranch: 'feature',
  destination: '/p',
  destinationBranch: 'main',
}
beforeEach(() => {
  forgetMainWorktree('p')
  vi.mocked(gitWorktrees).mockReset()
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject(project)
  useStore.setState({ workspaceSettings: {}, sessions: {}, sessionRecords: [] })
  vi.mocked(mergeCleanupPreview)
    .mockReset()
    .mockResolvedValue({ restore: false, retry: false, removedWorktree: '/feature' })
  vi.mocked(mergeOutcome).mockReset().mockResolvedValue('merged')
})

test.each([false, true])(
  'restoration refreshes the cached branch, including partial failure (%s)',
  async (partialFailure) => {
    const tree = (branch: string) => [
      { path: project.root, branch, head: 'head', current: true, main: true },
    ]
    vi.mocked(gitWorktrees)
      .mockResolvedValueOnce(tree('feature'))
      .mockResolvedValueOnce(tree('main'))
    refreshMainWorktree('p')
    await vi.waitFor(() => expect(useMainWorktree.getState().p?.branch).toBe('feature'))
    trackMergeCleanup(project, request, 'session', 'merge', 'ask', false)
    const failure = new Error('Original folder restored; branch deletion failed')
    if (partialFailure) vi.mocked(mergeCleanup).mockRejectedValueOnce(failure)
    else vi.mocked(mergeCleanup).mockResolvedValueOnce(undefined)
    const cleanup = deleteMergedWork(cleanupJobs()[0])
    if (partialFailure) await expect(cleanup).rejects.toThrow(failure.message)
    else await cleanup
    await vi.waitFor(() => expect(useMainWorktree.getState().p?.branch).toBe('main'))
  },
)

test('tracks cleanup independently of the visible view and remembers dismissal', () => {
  trackMergeCleanup(project, request, 'session', 'merge', 'ask', false)
  expect(cleanupJobs()[0]).toMatchObject({ choice: 'ask', projectId: 'p' })
  handledCleanup('merge')
  expect(cleanupJobs()[0].handled).toBe(true)
})

test('waits for a finished session and confirmed Git integration', async () => {
  trackMergeCleanup(project, request, 'session', 'merge', 'ask', false)
  const job = cleanupJobs()[0]
  expect(await readyCleanup(job)).toBe(false)
  useStore.setState({ sessions: { session: { running: true } } as never })
  expect(await readyCleanup(job)).toBe(false)
  expect(mergeOutcome).not.toHaveBeenCalled()
  useStore.setState({ sessions: { session: { running: false } } as never })
  expect(await readyCleanup(job)).toBe(true)
  vi.mocked(mergeOutcome).mockResolvedValue('notMerged')
  expect(await readyCleanup(job)).toBe(false)
  vi.mocked(mergeOutcome).mockResolvedValue('inProgress')
  expect(await readyCleanup(job)).toBe(false)
})

test.each(['ask', 'delete'] as const)(
  'Auto %s cleanup survives normal completion and controller resumes',
  async (choice) => {
    trackMergeCleanup(project, request, 'session', 'merge', choice, true, 'owner')
    useStore.setState({
      sessions: { session: { running: false } } as never,
      auto: {
        runId: 'first',
        ownershipId: 'owner',
        sessionId: 'session',
        status: 'running',
      } as never,
    })
    expect(await readyCleanup(cleanupJobs()[0])).toBe(false)
    useStore.setState({
      auto: { runId: 'resumed', ownershipId: 'owner', status: 'done' } as never,
    })
    expect(await readyCleanup(cleanupJobs()[0])).toBe(true)
  },
)

test('a different Auto run cannot authorize cleanup through a reused merge session', async () => {
  trackMergeCleanup(project, request, 'session', 'merge', 'delete', true, 'original')
  useStore.setState({
    sessions: { session: { running: false } } as never,
    auto: { runId: 'new', sessionId: 'session', status: 'done' } as never,
  })
  expect(await readyCleanup(cleanupJobs()[0])).toBe(false)
  expect(mergeOutcome).not.toHaveBeenCalled()
})

test('completed Auto cleanup follows its run in an inactive task workspace', async () => {
  trackMergeCleanup(project, request, 'session', 'merge', 'ask', true, 'run')
  useStore.setState({
    sessions: { session: { running: false } } as never,
    auto: null,
    taskWorkspaces: { task: { auto: { runId: 'run', status: 'done' } } } as never,
  })
  expect(await readyCleanup(cleanupJobs()[0])).toBe(true)
})

test('a newer merge replaces an older pending prompt for the same branch pair', () => {
  trackMergeCleanup(project, request, 'old-session', 'old', 'ask', false)
  trackMergeCleanup(project, request, 'new-session', 'new', 'ask', false)
  expect(cleanupJobs().map((j) => j.id)).toEqual(['new'])
})

test('partial restoration remains available after its merge session was retired', async () => {
  trackMergeCleanup(project, request, 'retired-session', 'merge', 'ask', false)
  expect(await readyCleanup(cleanupJobs()[0])).toBe(false)
  vi.mocked(mergeCleanupPreview).mockResolvedValue({
    restore: true,
    retry: true,
    removedWorktree: '/generated-main',
  })
  expect(await readyCleanup(cleanupJobs()[0])).toBe(true)
})

test('finish cancels only cleanup from the matching worktree and cycle', () => {
  useStore.setState({ tasks: [{ id: 'other', worktree: '/other' }] as never })
  trackMergeCleanup(project, request, 'old-session', 'old', 'delete', false)
  trackMergeCleanup(
    project,
    { ...request, source: '/other' },
    'other-session',
    'other',
    'ask',
    false,
  )
  trackMergeCleanup(
    { ...project, projectId: 'q' },
    request,
    'foreign-session',
    'foreign',
    'ask',
    false,
  )
  expect(retireTaskCleanup('p', null, '').map((j) => j.id)).toEqual(['old'])
  expect(cleanupCurrent(cleanupJobs().find((j) => j.id === 'old')!)).toBe(false)
  expect(cleanupJobs().find((j) => j.id === 'other')?.handled).not.toBe(true)
  expect(cleanupJobs().find((j) => j.id === 'foreign')?.handled).not.toBe(true)
  useStore.getState().patchTask('p', null, { workCycle: 'next' })
  trackMergeCleanup(project, request, 'new-session', 'new', 'ask', false)
  retireTaskCleanup('p', null, '')
  expect(cleanupCurrent(cleanupJobs().find((j) => j.id === 'new')!)).toBe(true)
})

test('an in-flight cleanup readiness result cannot authorize deletion after Finish', async () => {
  let resolve!: (value: 'merged') => void
  vi.mocked(mergeCleanup).mockClear()
  vi.mocked(mergeOutcome).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  trackMergeCleanup(project, request, 'session', 'old', 'delete', false)
  useStore.setState({ sessions: { session: { running: false } } as never })
  const job = cleanupJobs()[0]
  const pending = readyCleanup(job)
  retireTaskCleanup('p', null, '')
  resolve('merged')
  expect(await pending).toBe(false)
  await expect(deleteMergedWork(job)).rejects.toThrow('cancelled')
  expect(mergeCleanup).not.toHaveBeenCalled()
})

test('an unresolved legacy cleanup source is not retired as the main worktree', () => {
  const legacy = {
    id: 'legacy',
    projectId: 'p',
    request,
    sessionId: 'old',
    choice: 'delete',
    auto: false,
  }
  useStore.setState({ workspaceSettings: { mergeCleanupJobs: [legacy] } })
  expect(retireTaskCleanup('p', null, '')).toEqual([])
  expect(cleanupJobs()[0].handled).not.toBe(true)
  expect(cleanupCurrent(cleanupJobs()[0])).toBe(false)
})
