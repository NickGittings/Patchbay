import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import {
  MERGE_SCOPE,
  REVIEW_SCOPE,
  TASK_ROOT_SCOPE,
  type SessionRecord,
  type Story,
  type Task,
} from '../types'
vi.mock('./ipc', () => ({ gitWorktrees: vi.fn(), mergeOutcome: vi.fn(), storyUpdate: vi.fn() }))
vi.mock('./sessions', () => ({ startTerminal: vi.fn() }))
vi.mock('./workspace', () => ({ flushWorkspace: vi.fn(async () => {}) }))
vi.mock('./stories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./stories')>()),
  refreshStories: vi.fn(),
}))
const ipc = await import('./ipc')
const { refreshStories } = await import('./stories')
const { storyProgressPoll } = await import('./storyProgress')
const story: Story = {
  id: 's',
  kind: 'story',
  parent: null,
  title: 'Story',
  description: '',
  acceptance: [],
  components: [],
  task: 't',
  taskHead: 'baseline',
  status: 'planned',
  createdMs: 1,
  order: 1,
}
beforeEach(() => {
  vi.clearAllMocks()
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
    stories: [story],
    tasks: [{ id: 't', worktree: '/task', branch: 'feature', missing: false } as Task],
    sessionRecords: [
      {
        id: 'merge',
        metadata: { projectId: 'p', componentId: MERGE_SCOPE },
        spec: { cwd: '/p', merge_source: '/task' },
        snapshot: { running: false, generation: 1 },
      } as SessionRecord,
    ],
  })
  vi.mocked(ipc.gitWorktrees).mockResolvedValue([
    { path: '/p', branch: 'main', head: 'destination', current: true, main: true },
    { path: '/task', branch: 'feature', head: 'source', current: false, main: false },
  ])
  vi.mocked(ipc.mergeOutcome).mockResolvedValue('notMerged')
  vi.mocked(ipc.storyUpdate).mockImplementation(async (_projectId, id, patch) => ({
    ...useStore.getState().stories.find((s) => s.id === id)!,
    status: patch.status!,
  }))
})
test('polls the board but caches Git across task/story object replacement until a Git refresh', async () => {
  const progress = storyProgressPoll('p')
  try {
    await progress.poll()
    useStore.setState({
      stories: [{ ...story, title: 'Edited' }],
      tasks: [...useStore.getState().tasks],
    })
    await progress.poll()
    expect(refreshStories).toHaveBeenCalledTimes(2)
    expect(ipc.gitWorktrees).toHaveBeenCalledOnce()
    expect(ipc.mergeOutcome).toHaveBeenCalledOnce()
    useStore.setState({ gitChanges: {} })
    await progress.poll()
    expect(ipc.gitWorktrees).toHaveBeenCalledTimes(2)
    expect(ipc.mergeOutcome).toHaveBeenCalledTimes(2)
    vi.mocked(ipc.mergeOutcome).mockResolvedValueOnce('merged')
    useStore.setState({ gitChanges: {} })
    await progress.poll()
    // A confirmed outcome saved by the backend is reloaded immediately.
    expect(refreshStories).toHaveBeenCalledTimes(5)
  } finally {
    progress.dispose()
  }
})
test('saves Building, Review, Merge and a later fix, skipping Done stories and parents', async () => {
  const items: Story[] = [
    story,
    { ...story, id: 'done', status: 'done' },
    { ...story, id: 'e', kind: 'epic' },
    { ...story, id: 'f', kind: 'feature', parent: 'e' },
  ]
  useStore.setState({ stories: items, sessionRecords: [] })
  const progress = storyProgressPoll('p')
  try {
    await progress.poll()
    expect(ipc.storyUpdate).not.toHaveBeenCalled()
    let records: SessionRecord[] = []
    let previous = story.status
    let startedMs = 0
    for (const [scope, status] of [
      [TASK_ROOT_SCOPE, 'building'],
      [REVIEW_SCOPE, 'reviewing'],
      [MERGE_SCOPE, 'merging'],
      [TASK_ROOT_SCOPE, 'building'],
    ] as const) {
      records = [
        ...records,
        {
          id: `${scope}-${++startedMs}`,
          metadata: {
            projectId: 'p',
            componentId: scope,
            task: 't',
            branch: 'feature',
            kind: 'agent',
          },
          spec: { cwd: '/p', merge_source: '/task' },
          snapshot: { startedMs, running: true },
        } as SessionRecord,
      ]
      useStore.setState({ sessionRecords: records })
      await progress.poll()
      expect(ipc.storyUpdate).toHaveBeenLastCalledWith('p', story.id, {
        status,
        expectedProgress: { status: previous, task: 't' },
      })
      expect(useStore.getState().stories.map((s) => s.status)).toEqual([
        status,
        'done',
        'planned',
        'planned',
      ])
      previous = status
      await progress.poll()
    }
    useStore.setState({ tasks: [], sessionRecords: [] })
    await progress.poll()
    expect(useStore.getState().stories[0].status).toBe('building')
    expect(ipc.storyUpdate).toHaveBeenCalledTimes(4)
  } finally {
    progress.dispose()
  }
})
test('does not apply stale Git results after the watcher is disposed', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof ipc.gitWorktrees>>) => void
  vi.mocked(ipc.gitWorktrees).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    }),
  )
  const progress = storyProgressPoll('p')
  const pending = progress.poll()
  await vi.waitFor(() => expect(ipc.gitWorktrees).toHaveBeenCalledOnce())
  progress.dispose()
  resolve([])
  await pending
  expect(ipc.mergeOutcome).not.toHaveBeenCalled()
})
test('a failed stage save still checks merges for the rest of the board', async () => {
  useStore.setState({
    sessionRecords: [
      ...useStore.getState().sessionRecords,
      {
        id: 'build',
        metadata: { projectId: 'p', componentId: TASK_ROOT_SCOPE, task: 't', kind: 'agent' },
        spec: { cwd: '/task' },
        snapshot: { startedMs: 1, running: true },
      } as SessionRecord,
    ],
  })
  vi.mocked(ipc.storyUpdate).mockRejectedValueOnce(new Error('Unknown story s'))
  const progress = storyProgressPoll('p')
  try {
    await progress.poll()
    expect(ipc.storyUpdate).toHaveBeenCalledOnce()
    expect(ipc.mergeOutcome).toHaveBeenCalledOnce()
  } finally {
    progress.dispose()
  }
})
