import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import type { SessionRecord, TerminalSnapshot } from '../types'
vi.mock('./ipc', () => ({ terminalSnapshot: vi.fn(), terminalStop: vi.fn() }))
vi.mock('./reviewAgents', () => ({
  reviewWorktreeBusy: vi.fn(() => false),
  startReviewAgents: vi.fn(),
}))
const ipc = await import('./ipc')
const agents = await import('./reviewAgents')
const { startSimpleReview } = await import('./simpleReview')
const request = { worktree: '/t', branch: 'feature', base: 'main' }
const snapshot = {
  generation: 1,
  running: true,
  status: { agent: { state: 'review', authoritative: true } },
} as TerminalSnapshot
beforeEach(() => {
  vi.resetAllMocks()
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    root: '/p',
    name: 'P',
    schemaVersion: 4,
    components: [],
    links: [],
  })
  useStore.setState({
    sessionRecords: [
      {
        id: 'r',
        metadata: { projectId: 'p', componentId: '@review' },
        spec: { cwd: '/t' },
        snapshot,
        history: [],
      } as unknown as SessionRecord,
    ],
  })
})
test('review again stops a settled previous generation before starting a new round', async () => {
  vi.mocked(ipc.terminalSnapshot)
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ ...snapshot, running: false })
  await startSimpleReview(useStore.getState().toProject(), request, [])
  expect(ipc.terminalStop).toHaveBeenCalledWith('r')
  expect(agents.startReviewAgents).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 'p' }),
    request,
    [],
  )
  expect(vi.mocked(ipc.terminalStop).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(agents.startReviewAgents).mock.invocationCallOrder[0],
  )
})
test('another turn, generation, or worktree prevents stopping the reviewer', async () => {
  for (const changed of [
    { ...snapshot, generation: 2 },
    {
      ...snapshot,
      status: {
        ...snapshot.status,
        agent: { ...snapshot.status.agent!, state: 'working' as const },
      },
    },
  ]) {
    vi.mocked(ipc.terminalSnapshot).mockResolvedValueOnce(changed)
    await expect(startSimpleReview(useStore.getState().toProject(), request, [])).rejects.toThrow(
      'another turn',
    )
  }
  vi.mocked(ipc.terminalSnapshot).mockImplementationOnce(async () => {
    useStore.setState({ activeTask: 'other' })
    return snapshot
  })
  await expect(startSimpleReview(useStore.getState().toProject(), request, [])).rejects.toThrow(
    'worktree changed',
  )
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  expect(agents.startReviewAgents).not.toHaveBeenCalled()
})

test('a busy review is preserved before any stop or launch request', async () => {
  vi.mocked(agents.reviewWorktreeBusy).mockReturnValueOnce(true)
  await expect(startSimpleReview(useStore.getState().toProject(), request, [])).rejects.toThrow(
    'current review',
  )
  expect(ipc.terminalSnapshot).not.toHaveBeenCalled()
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  expect(agents.startReviewAgents).not.toHaveBeenCalled()
})
