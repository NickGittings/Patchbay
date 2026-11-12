import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import { cleanupJobs, handledCleanup, readyCleanup, trackMergeCleanup } from './mergeCleanup'
import { mergeOutcome } from './ipc'
import type { Project } from '../types'

vi.mock('./ipc', () => ({ mergeOutcome: vi.fn(), mergeCleanup: vi.fn() }))
vi.mock('./sessions', () => ({ reconcileFreshSessions: vi.fn() }))
vi.mock('./tasks', () => ({ refreshTasks: vi.fn() }))
vi.mock('./git', () => ({ requestGitRefresh: vi.fn() }))

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
  useStore.getState().loadProject(project)
  useStore.setState({ workspaceSettings: {}, sessions: {}, sessionRecords: [] })
  vi.mocked(mergeOutcome).mockReset().mockResolvedValue('merged')
})

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

test('Auto cleanup waits until the run is done', async () => {
  trackMergeCleanup(project, request, 'session', 'merge', 'delete', true)
  useStore.setState({
    sessions: { session: { running: false } } as never,
    auto: { sessionId: 'session', status: 'running' } as never,
  })
  expect(await readyCleanup(cleanupJobs()[0])).toBe(false)
  useStore.setState({ auto: { sessionId: 'session', status: 'done' } as never })
  expect(await readyCleanup(cleanupJobs()[0])).toBe(true)
})

test('a newer merge replaces an older pending prompt for the same branch pair', () => {
  trackMergeCleanup(project, request, 'old-session', 'old', 'ask', false)
  trackMergeCleanup(project, request, 'new-session', 'new', 'ask', false)
  expect(cleanupJobs().map((j) => j.id)).toEqual(['new'])
})
