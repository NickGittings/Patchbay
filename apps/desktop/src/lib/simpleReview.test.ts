import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import type { DeviceManifest, SessionRecord, TerminalSnapshot } from '../types'
vi.mock('./ipc', () => ({ terminalSnapshot: vi.fn(), terminalStop: vi.fn() }))
vi.mock('./reviewAgents', () => ({
  reviewWorktreeBusy: vi.fn(() => false),
  startReviewAgents: vi.fn(),
}))
const ipc = await import('./ipc')
const agents = await import('./reviewAgents')
const { simpleReviewRequest, startSimpleReview } = await import('./simpleReview')
const devices = [{ id: 'claude' } as DeviceManifest]
const request = { worktree: '/t', branch: 'feature', base: 'main' }
const snapshot = {
  generation: 1,
  running: true,
  status: { agent: { state: 'review', authoritative: true } },
} as TerminalSnapshot

test('Review explains missing worktrees, detached HEAD and unresolved bases', () => {
  expect(() => simpleReviewRequest(undefined, 'main')).toThrow('worktree to load')
  expect(() => simpleReviewRequest({ path: '/t' }, 'main')).toThrow('HEAD is detached')
  expect(() => simpleReviewRequest({ path: '/t', branch: 'feature' }, undefined)).toThrow(
    'Choose a review base in Options',
  )
  expect(simpleReviewRequest({ path: '/t', branch: 'feature' }, 'main')).toEqual(request)
})
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(agents.startReviewAgents).mockResolvedValue({ started: [], round: 'round', errors: [] })
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
  await startSimpleReview(useStore.getState().toProject(), request, devices)
  expect(ipc.terminalStop).toHaveBeenCalledWith('r')
  expect(agents.startReviewAgents).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 'p' }),
    request,
    devices,
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
    await expect(
      startSimpleReview(useStore.getState().toProject(), request, devices),
    ).rejects.toThrow('another turn')
  }
  vi.mocked(ipc.terminalSnapshot).mockImplementationOnce(async () => {
    useStore.setState({ activeTask: 'other' })
    return snapshot
  })
  await expect(
    startSimpleReview(useStore.getState().toProject(), request, devices),
  ).rejects.toThrow('worktree changed')
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  expect(agents.startReviewAgents).not.toHaveBeenCalled()
})

test('a busy review is preserved before any stop or launch request', async () => {
  vi.mocked(agents.reviewWorktreeBusy).mockReturnValueOnce(true)
  await expect(
    startSimpleReview(useStore.getState().toProject(), request, devices),
  ).rejects.toThrow('current review')
  expect(ipc.terminalSnapshot).not.toHaveBeenCalled()
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  expect(agents.startReviewAgents).not.toHaveBeenCalled()
})

test('a relaunched reviewer is hydrated before Chat records its kickoff generation', async () => {
  const { logSimple } = await import('./simpleActions')
  const { flow } = await import('./simpleFlow')
  useStore.setState({ sessions: { r: { generation: 1, running: false } } })
  const fresh = {
    ...snapshot,
    generation: 2,
    running: true,
    startedMs: 200,
    status: { agent: { state: 'idle', authoritative: true, turnId: null } },
  } as TerminalSnapshot
  vi.mocked(ipc.terminalSnapshot)
    .mockResolvedValueOnce({ ...snapshot, running: false })
    .mockResolvedValueOnce(fresh)
  vi.mocked(agents.startReviewAgents).mockResolvedValue({
    started: [{ sessionId: 'r', requestId: 'request', lane: null }],
    round: 'round',
    errors: [],
  })
  const result = await startSimpleReview(useStore.getState().toProject(), request, devices)
  const sid = result.started[0].sessionId
  logSimple('p', null, {
    kind: 'action',
    action: 'review',
    stage: 'review',
    sessionId: sid,
    generation: useStore.getState().sessions[sid]?.generation,
  })
  const s = useStore.getState()
  expect(s.simple?.log.at(-1)?.generation).toBe(2)
  const record = {
    ...s.sessionRecords[0],
    metadata: { ...s.sessionRecords[0].metadata, kind: 'agent' as const },
  }
  const resultFlow = flow({
    worktree: { projectId: 'p', task: null, path: '/t' },
    records: [record],
    sessions: s.sessions,
    simple: s.simple,
    auto: null,
  })
  expect(resultFlow.step).toBe('reviewing')
  expect(resultFlow.prompt).toBeUndefined()
  expect(ipc.terminalSnapshot).toHaveBeenLastCalledWith('r', 0)
})

test('review again stops only the lanes the selected presets will reuse', async () => {
  const base = useStore.getState().sessionRecords[0]
  const records = [null, 'claude', 'codex', 'other'].map((lane) => ({
    ...base,
    id: lane ?? 'single',
    metadata: { ...base.metadata, lane },
  }))
  useStore.setState({ sessionRecords: records })
  vi.mocked(ipc.terminalSnapshot).mockImplementation(async (sid) => ({
    ...snapshot,
    running: !vi.mocked(ipc.terminalStop).mock.calls.some(([stopped]) => stopped === sid),
  }))
  await startSimpleReview(useStore.getState().toProject(), request, [
    { id: 'claude' },
    { id: 'codex' },
  ] as DeviceManifest[])
  expect(vi.mocked(ipc.terminalStop).mock.calls).toEqual([['claude'], ['codex']])
  vi.mocked(ipc.terminalStop).mockClear()
  await startSimpleReview(useStore.getState().toProject(), request, devices)
  expect(vi.mocked(ipc.terminalStop).mock.calls).toEqual([['single']])
})

test('an empty preset selection cannot retire any reviewers', async () => {
  await expect(startSimpleReview(useStore.getState().toProject(), request, [])).rejects.toThrow(
    'at least one agent',
  )
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  expect(agents.startReviewAgents).not.toHaveBeenCalled()
})

test('review hydration stores session fields without terminal output or snapshot metadata', async () => {
  vi.mocked(ipc.terminalSnapshot)
    .mockResolvedValueOnce({ ...snapshot, running: false })
    .mockResolvedValueOnce({
      ...snapshot,
      generation: 2,
      data: 'large output',
      end: 999,
      launchDirectory: '/t',
      lastReply: 10,
    })
  vi.mocked(agents.startReviewAgents).mockResolvedValue({
    started: [{ sessionId: 'r', requestId: 'new', lane: null }],
    round: 'round',
    errors: [],
  })
  await startSimpleReview(useStore.getState().toProject(), request, devices)
  const stored = useStore.getState().sessions.r
  expect(stored).toMatchObject({ generation: 2, running: true })
  for (const key of ['data', 'end', 'launchDirectory', 'lastReply'])
    expect(stored).not.toHaveProperty(key)
})
