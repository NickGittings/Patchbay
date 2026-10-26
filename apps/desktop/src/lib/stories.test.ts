import { beforeEach, expect, test, vi } from 'vitest'
import { projectStateOf, useStore } from '../store'
import { PLAN_SCOPE, plannerSessionId, type AutoRun, type Story, type Task } from '../types'
vi.mock('./ipc', () => ({
  storyList: vi.fn(),
  storyUpdate: vi.fn(),
  storyCompleteAuto: vi.fn(async () => []),
  terminalSnapshot: vi.fn(async () => null),
  terminalStop: vi.fn(),
}))
vi.mock('./sessions', () => ({ startTerminal: vi.fn() }))
const {
  tree,
  derivedStatus,
  rollup,
  storyGoal,
  planStory,
  autoStory,
  linkAutoStory,
  refreshStories,
  updateStory,
  completeAutoStories,
} = await import('./stories')
const ipc = await import('./ipc')
const { startTerminal } = await import('./sessions')
const { autoDrafts, autoDraftKey } = await import('./autoDrafts')
const story = (
  id: string,
  kind: Story['kind'] = 'story',
  parent: string | null = null,
  order = 0,
): Story => ({
  id,
  kind,
  parent,
  order,
  title: id,
  description: 'Description',
  acceptance: ['Works'],
  components: ['api'],
  task: null,
  status: 'backlog',
  createdMs: 1,
})
const task: Task = {
  id: 'task',
  title: 'Task',
  worktree: '/task',
  components: [],
  notes: '',
  createdMs: 1,
  missing: false,
  current: false,
}
beforeEach(() => {
  vi.clearAllMocks()
  autoDrafts.clear()
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    root: '/p',
    name: 'P',
    schemaVersion: 4,
    links: [],
    components: ['api', 'web'].map((id) => ({
      id,
      name: id,
      path: id,
      kind: 'app',
      notes: '',
      position: { x: 0, y: 0 },
      terminals: [],
    })),
  })
  vi.mocked(ipc.storyUpdate).mockImplementation(
    async (_project, id, patch) => ({ ...story(id), ...patch }) as Story,
  )
})
test('tree orders each hierarchy level and keeps orphan stories under Unassigned', () => {
  const items = [
    story('s2', 'story', 'f', 2),
    story('s1', 'story', 'f', 1),
    story('e2', 'epic', null, 2),
    story('f', 'feature', 'e1'),
    story('e1', 'epic', null, 1),
    story('orphan', 'story', 'missing'),
    story('free'),
  ]
  const hierarchy = tree(items)
  expect(hierarchy.epics.map((e) => e.item.id)).toEqual(['e1', 'e2'])
  expect(hierarchy.epics[0].features[0].stories.map((s) => s.id)).toEqual(['s1', 's2'])
  expect(hierarchy.unassigned.map((s) => s.id)).toEqual(['free', 'orphan'])
  expect(tree([])).toEqual({ epics: [], unassigned: [] })
})
test('status ignores old Auto runs on reused tasks and preserves saved completion after cleanup', () => {
  const item = { ...story('s'), task: 'task' }
  expect(derivedStatus(story('s'), [], {})).toBe('backlog')
  expect(derivedStatus({ ...item, status: 'planned' }, [], {})).toBe('planned')
  expect(derivedStatus(item, [task], {})).toBe('building')
  expect(derivedStatus(item, [{ ...task, missing: true }], {})).toBe('backlog')
  const done = { task: { runId: 'old', status: 'done' as const } }
  expect(derivedStatus(item, [task], done)).toBe('building')
  expect(derivedStatus({ ...item, autoRunId: 'new' }, [task], done)).toBe('building')
  expect(derivedStatus({ ...item, autoRunId: 'old' }, [task], done)).toBe('done')
  expect(derivedStatus({ ...item, status: 'done' }, [], {})).toBe('done')
})
test('rollup picks the least advanced child and retains a childless parent', () => {
  expect(rollup('planned', [])).toBe('planned')
  expect(rollup('backlog', ['done', 'building'])).toBe('building')
  expect(rollup('building', ['done', 'planned', 'backlog'])).toBe('backlog')
  expect(rollup('planned', ['done', 'done'])).toBe('done')
})
test('goals include acceptance and descendants in hierarchy order', () => {
  const epic = story('Epic', 'epic')
  const items = [story('Story', 'story', 'Feature'), story('Feature', 'feature', 'Epic')]
  expect(storyGoal(epic, items)).toBe(
    'Epic\n\nDescription\n\n- [ ] Works\n\nFeature\n\nDescription\n\n- [ ] Works\n\nStory\n\nDescription\n\n- [ ] Works',
  )
})
test('Plan chooses the role, replaces highlights and marks Planned only after launch', async () => {
  const item = story('s')
  useStore.setState({ stories: [item] })
  useStore.getState().setAgentRoles({ plan: ['agent'] })
  useStore.getState().setDevices([
    {
      id: 'agent',
      name: 'Agent',
      kind: 'agent',
      category: 'agent',
      command: 'cat',
      source: 'builtin',
    },
  ])
  useStore.getState().toggleHighlight('web')
  await planStory('p', item)
  expect(startTerminal).toHaveBeenCalledWith(PLAN_SCOPE, 'agent', null, 'p', {
    kickoff: { kind: 'planStory' },
    story: 's',
  })
  expect(useStore.getState()).toMatchObject({
    view: 'plan',
    planActive: 'agent',
    highlighted: ['api'],
    dirty: false,
  })
  expect(ipc.storyUpdate).toHaveBeenCalledWith('p', 's', { status: 'planned' })
  vi.mocked(startTerminal).mockRejectedValueOnce(new Error('Failed'))
  vi.mocked(ipc.storyUpdate).mockClear()
  await expect(planStory('p', item)).rejects.toThrow('Failed')
  expect(ipc.storyUpdate).not.toHaveBeenCalled()
})
test('Auto drafts carry story goals; linkage is recorded only once a run has a task', async () => {
  const item = story('s')
  useStore.setState({ stories: [item] })
  autoStory('p', item)
  expect(autoDrafts.get(autoDraftKey('p', null))).toMatchObject({
    story: 's',
    goal: storyGoal(item),
  })
  expect(useStore.getState().utilityPanel).toBe('auto')
  expect(ipc.storyUpdate).not.toHaveBeenCalled()
  await linkAutoStory('p', null, 's')
  expect(ipc.storyUpdate).not.toHaveBeenCalled()
  await linkAutoStory('p', 'task', 's')
  expect(ipc.storyUpdate).toHaveBeenCalledWith('p', 's', { task: 'task', autoRunId: '' })
})
test('an inactive project receives story updates and stale loads cannot overwrite them', async () => {
  const item = story('s')
  useStore.setState({ stories: [item] })
  let resolve!: (items: Story[]) => void
  vi.mocked(ipc.storyList).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  const loading = refreshStories('p')
  useStore.getState().loadProject({
    projectId: 'q',
    root: '/q',
    name: 'Q',
    schemaVersion: 4,
    components: [],
    links: [],
  })
  await updateStory('p', 's', { status: 'planned' })
  resolve([item])
  await loading
  expect(projectStateOf('p')?.stories[0].status).toBe('planned')
  expect(useStore.getState().stories).toEqual([])
})

const run = (patch: Partial<AutoRun> = {}): AutoRun => ({
  runId: 'run',
  status: 'running',
  stage: 'plan',
  goal: 'Goal',
  effort: 'standard',
  device: 'agent',
  round: 0,
  log: [],
  merge: { mode: 'ask', destinationBranch: 'main' },
  ...patch,
})
const planner = () => {
  useStore.getState().setDevices([
    {
      id: 'agent',
      name: 'Agent',
      command: 'cat',
      kind: 'agent',
      category: 'agent',
      source: 'builtin',
    },
  ])
}
test('Plan refuses an Auto-owned planner across worktrees before changing highlights or stopping it', async () => {
  planner()
  const sid = plannerSessionId('agent', 'p')
  useStore.getState().patchTask('p', 'other', { auto: run({ sessionId: sid, status: 'paused' }) })
  await expect(planStory('p', story('s'))).rejects.toThrow('Stop the Auto run')
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  expect(startTerminal).not.toHaveBeenCalled()
  expect(useStore.getState().view).toBe('navigation')
})
test('Plan asks before replacing a manual planner, and cancellation leaves it alone', async () => {
  planner()
  vi.stubGlobal('window', { confirm: vi.fn(() => false) })
  vi.mocked(ipc.terminalSnapshot).mockResolvedValueOnce({ running: true } as never)
  await planStory('p', story('s'))
  expect(window.confirm).toHaveBeenCalledOnce()
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  expect(startTerminal).not.toHaveBeenCalled()
  vi.stubGlobal('window', { confirm: vi.fn(() => true) })
  vi.mocked(ipc.terminalSnapshot).mockResolvedValueOnce({ running: true } as never)
  await planStory('p', story('s'))
  expect(ipc.terminalStop).toHaveBeenCalledOnce()
  expect(startTerminal).toHaveBeenCalledOnce()
  vi.unstubAllGlobals()
})
test('story Auto preserves draft choices and refuses an unfinished run without leaving a draft', () => {
  const key = autoDraftKey('p', null)
  const choices = {
    effort: 'thorough' as const,
    mode: 'auto' as const,
    picked: { plan: 'custom' },
    overrides: { maxRounds: 8 },
    stage: 'review' as const,
    destination: 'release',
  }
  autoDrafts.set(key, choices)
  useStore.setState({ auto: run() })
  autoStory('p', story('blocked'))
  expect(autoDrafts.get(key)).toBe(choices)
  expect(useStore.getState().message).toContain('already has an Auto run')
  useStore.setState({ auto: run({ status: 'done' }) })
  autoStory('p', story('next'))
  expect(autoDrafts.get(key)).toMatchObject({
    ...choices,
    story: 'next',
    goal: storyGoal(story('next')),
  })
})
test('refresh clears a deleted planner story, including after cascade deletion', async () => {
  useStore.setState({ planStory: 'deleted', planStoryTerminal: 'agent' })
  vi.mocked(ipc.storyList).mockResolvedValueOnce([])
  await refreshStories('p')
  expect(useStore.getState()).toMatchObject({ planStory: null, planStoryTerminal: null })
})
test('completion persists only the linked Auto run and stays Done when its worktree is removed', async () => {
  const linked = { ...story('s'), task: 'task', autoRunId: 'new' }
  useStore.setState({ stories: [linked] })
  await completeAutoStories('p', 'task', 'old')
  expect(ipc.storyCompleteAuto).not.toHaveBeenCalled()
  vi.mocked(ipc.storyCompleteAuto).mockResolvedValueOnce([{ ...linked, status: 'done' }])
  await completeAutoStories('p', 'task', 'new')
  expect(ipc.storyCompleteAuto).toHaveBeenCalledWith('p', 'task', 'new')
  expect(derivedStatus(useStore.getState().stories[0], [], {})).toBe('done')
})

test('latest review, merge or root record determines a live story stage', async () => {
  const { worktreeStage } = await import('./stories')
  const record = (scope: string, startedMs: number) =>
    ({
      id: `${scope}:${startedMs}`,
      metadata: { projectId: 'p', componentId: scope, task: task.id, branch: 'feature' },
      spec: { cwd: task.worktree, merge_source: task.worktree },
      snapshot: { startedMs },
    }) as unknown as import('../types').SessionRecord
  const t = { ...task, branch: 'feature' }
  const records = [record('@task', 1), record('@review', 2), record('@merge', 3)]
  expect(worktreeStage(t, 'p', records.slice(0, 2))).toBe('reviewing')
  expect(worktreeStage(t, 'p', records)).toBe('merging')
  expect(worktreeStage(t, 'p', [...records, record('@task', 4)])).toBe('building')
  expect(worktreeStage(t, 'other', records)).toBe('building')
  expect(derivedStatus({ ...story('s'), task: task.id }, [t], {}, records)).toBe('merging')
  for (const [stage, expected] of [
    ['review', 'reviewing'],
    ['mergeGate', 'merging'],
    ['merge', 'merging'],
    ['fix', 'building'],
  ] as const)
    expect(derivedStatus({ ...story('s'), task: task.id }, [t], { task: run({ stage }) })).toBe(
      expected,
    )
  expect(rollup('done', ['reviewing', 'merging', 'done'])).toBe('reviewing')
})
test('worktree creation for a story scopes descendants and links in its follow-up', async () => {
  const { newWorktreeForStory } = await import('./stories')
  const tasks = await import('./tasks')
  const seeded = vi.spyOn(tasks, 'seedNewTask')
  const parent = story('parent', 'feature')
  useStore.setState({
    stories: [parent, { ...story('child', 'story', 'parent'), components: ['web'] }],
  })
  newWorktreeForStory('p', parent)
  expect(useStore.getState().newTask).toMatchObject({ title: 'parent', components: ['api', 'web'] })
  await seeded.mock.calls[0][0]!(task, 'p')
  expect(ipc.storyUpdate).toHaveBeenCalledWith('p', 'parent', { task: task.id })
  seeded.mockRestore()
})
test('planning a story in Chat retains the board, view and mode and logs the story name', async () => {
  planner()
  useStore.getState().setSimpleMode(true)
  useStore.getState().setStoryBoard(true)
  await planStory('p', story('Feature name'))
  expect(useStore.getState()).toMatchObject({
    simpleMode: true,
    view: 'navigation',
    storyBoard: true,
  })
  expect(useStore.getState().simple?.log.at(-1)).toMatchObject({
    kind: 'action',
    action: 'plan',
    text: 'Feature name',
  })
})
test('a replacing story planner logs its new run, and a worktree switch while stopping refuses', async () => {
  planner()
  useStore.getState().setSimpleMode(true)
  const sid = plannerSessionId('agent', 'p')
  useStore.getState().setSession(sid, { generation: 4, running: false })
  vi.stubGlobal('window', { confirm: vi.fn(() => true) })
  vi.mocked(ipc.terminalSnapshot)
    .mockResolvedValueOnce({ running: true } as never)
    .mockResolvedValueOnce({ running: false } as never)
    .mockResolvedValueOnce({ running: true, generation: 5 } as never)
  await planStory('p', story('Feature name'))
  expect(useStore.getState().simple?.log.at(-1)).toMatchObject({ sessionId: sid, generation: 5 })
  vi.mocked(ipc.terminalSnapshot)
    .mockResolvedValueOnce({ running: true } as never)
    .mockImplementationOnce(async () => {
      useStore.setState({ activeTask: 'other' })
      return { running: false } as never
    })
  await expect(planStory('p', story('Feature name'))).rejects.toThrow('The worktree changed')
  vi.unstubAllGlobals()
})
