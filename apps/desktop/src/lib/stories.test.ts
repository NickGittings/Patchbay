vi.mock('./workspace', () => ({ flushWorkspace: vi.fn(async () => {}) }))
import { beforeEach, expect, test, vi } from 'vitest'
import { projectStateOf, useStore } from '../store'
import {
  PLAN_SCOPE,
  plannerSessionId,
  type AutoRun,
  type Story,
  type StoryStatus,
  type Task,
} from '../types'
import type { StoryFilter } from './stories'
import { confirmAction } from './confirm'
vi.mock('./ipc', () => ({
  storyList: vi.fn(),
  storyUpdate: vi.fn(),
  storyReorder: vi.fn(async () => {}),
  storyCompleteAuto: vi.fn(async () => []),
  terminalSnapshot: vi.fn(async () => null),
  terminalStop: vi.fn(),
  sessionsList: vi.fn(async () => []),
}))
vi.mock('./sessions', () => ({ startTerminal: vi.fn() }))
vi.mock('./confirm', () => ({ confirmAction: vi.fn() }))
const {
  tree,
  filterStories,
  searchStories,
  storyStatuses,
  reopenStoryPatch,
  progressLabel,
  PARENT_FILTERS,
  STORY_FILTERS,
  STORY_STATUSES,
  storyGoal,
  planStory,
  autoStory,
  linkAutoStory,
  refreshStories,
  updateStory,
  completeAutoStories,
  boardOrder,
  siblings,
  reorder,
  moveStory,
  launchStoryPlanner,
  boardScope,
  UNASSIGNED,
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
const statusOf = (
  item: Story,
  tasks: Task[],
  runs: Parameters<typeof storyStatuses>[2],
  projectId: string,
  records: Parameters<typeof storyStatuses>[4] = [],
) => storyStatuses([item], tasks, runs, projectId, records).get(item.id)!.value
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
  // Workflow guards read the saved board; by default it matches the shown one.
  vi.mocked(ipc.storyList).mockImplementation(async () => useStore.getState().stories)
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
const filterItems: Story[] = STORY_STATUSES.map((value) => ({
  ...story(value),
  status: value === 'reviewing' || value === 'merging' ? 'backlog' : value,
  task: value === 'reviewing' || value === 'merging' ? value : null,
}))
const filterStatuses = storyStatuses(
  filterItems,
  ['reviewing', 'merging'].map((id) => ({ ...task, id })),
  {
    reviewing: { runId: 'review', status: 'running', stage: 'review' },
    merging: { runId: 'merge', status: 'waitingOnYou', stage: 'mergeGate' },
  },
  'p',
)
test.each(STORY_STATUSES)('column filter selects derived %s cards', (value) => {
  expect(filterStories(filterItems, filterStatuses, value).map((s) => s.id)).toEqual([value])
})
test('Active includes all four intermediate stages and excludes Backlog and Done', () => {
  expect(filterStories(filterItems, filterStatuses, 'active').map((s) => s.id)).toEqual([
    'planned',
    'building',
    'reviewing',
    'merging',
  ])
})
test('column filters use full-board rollups independently without adding context parents', () => {
  const items = [
    { ...story('epic', 'epic'), status: 'done' as const },
    story('feature', 'feature', 'epic'),
    { ...story('match', 'story', 'feature'), status: 'planned' as const },
    story('sibling', 'story', 'feature'),
  ]
  const statuses = storyStatuses(items, [], {}, 'p')
  expect(statuses.get('feature')?.value).toBe('active')
  const column = (kind: Story['kind']) => items.filter((s) => s.kind === kind)
  expect(filterStories(column('epic'), statuses, 'closed').map((s) => s.id)).toEqual(['epic'])
  expect(filterStories(column('feature'), statuses, 'active').map((s) => s.id)).toEqual(['feature'])
  expect(filterStories(column('feature'), statuses, 'closed')).toEqual([])
  expect(filterStories(column('story'), statuses, 'planned').map((s) => s.id)).toEqual(['match'])
  expect(filterStories(column('feature'), statuses, 'all')).toEqual(column('feature'))
  expect(items.map((s) => s.status)).toEqual(['done', 'backlog', 'planned', 'backlog'])
})
test('parent columns offer All, Active and Closed while stories offer the workflow stages', () => {
  expect(PARENT_FILTERS.map(({ value }) => value)).toEqual(['all', 'active', 'closed'])
  expect(STORY_FILTERS.map(({ value }) => value)).toEqual([
    'all',
    'backlog',
    'active',
    'planned',
    'building',
    'reviewing',
    'merging',
    'done',
  ])
})
test('column filtering preserves display order and includes matching orphan and unassigned stories', () => {
  const items = [
    story('epic', 'epic'),
    story('feature', 'feature', 'epic'),
    story('s2', 'story', 'feature', 2),
    story('s1', 'story', 'feature', 1),
    story('orphan', 'story', 'missing'),
    story('unassigned'),
    { ...story('hidden'), status: 'done' as const },
  ]
  const hierarchy = tree(items)
  const candidates = hierarchy.epics[0].features[0].stories.concat(hierarchy.unassigned)
  expect(
    filterStories(candidates, storyStatuses(items, [], {}, 'p'), 'backlog').map((s) => s.id),
  ).toEqual(['s1', 's2', 'orphan', 'unassigned'])
  expect(hierarchy).toEqual(tree(items))
})
test.each<StoryFilter>(['all', 'active', 'closed', ...STORY_STATUSES])(
  'column filter %s handles an empty board',
  (filter) => {
    expect(filterStories([], new Map(), filter)).toEqual([])
  },
)
test('All returns the full column without filtering or requiring statuses', () => {
  expect(filterStories(filterItems, new Map(), 'all')).toBe(filterItems)
})
test('column filter follows live derived status changes without changing saved story status', () => {
  const items = [{ ...story('live'), task: task.id }]
  for (const [stage, value] of [
    ['implement', 'building'],
    ['review', 'reviewing'],
    ['merge', 'merging'],
  ] as const) {
    const statuses = storyStatuses(
      items,
      [task],
      { task: { runId: 'run', status: 'running', stage } },
      'p',
    )
    for (const filter of ['building', 'reviewing', 'merging'] satisfies StoryStatus[]) {
      expect(filterStories(items, statuses, filter)).toEqual(filter === value ? items : [])
    }
  }
  expect(items[0].status).toBe('backlog')
})
test('status ignores old Auto runs on reused tasks and preserves saved completion after cleanup', () => {
  const item = { ...story('s'), task: 'task' }
  expect(statusOf(story('s'), [], {}, 'p')).toBe('backlog')
  expect(statusOf({ ...item, status: 'planned' }, [], {}, 'p')).toBe('planned')
  expect(statusOf(item, [task], {}, 'p')).toBe('backlog')
  expect(statusOf({ ...item, status: 'planned' }, [task], {}, 'p')).toBe('planned')
  expect(statusOf(item, [{ ...task, missing: true }], {}, 'p')).toBe('backlog')
  const done = { task: { runId: 'old', status: 'done' as const } }
  expect(statusOf(item, [task], done, 'p')).toBe('backlog')
  expect(statusOf({ ...item, autoRunId: 'new' }, [task], done, 'p')).toBe('backlog')
  expect(statusOf({ ...item, autoRunId: 'old' }, [task], done, 'p')).toBe('done')
  expect(statusOf({ ...item, status: 'done' }, [], {}, 'p')).toBe('done')
})
test('progress labels match card wording for every stage', () => {
  expect(STORY_STATUSES.map(progressLabel)).toEqual([
    'backlog',
    'planned',
    'building',
    'review',
    'merge',
    'done',
  ])
})
test('Active and Closed match the core parent status golden cases', () => {
  // Paired with core `stories::tests::parent_status_matches_the_board_golden_cases`.
  const board: Story[] = [
    { ...story('empty', 'epic'), status: 'building' },
    story('complete', 'epic'),
    story('allDone', 'feature', 'complete'),
    { ...story('done', 'story', 'allDone'), status: 'done' },
    { ...story('manual', 'feature', 'complete'), status: 'done' },
    { ...story('review', 'story', 'manual'), status: 'reviewing' },
    story('partial', 'epic'),
    story('emptyFeature', 'feature', 'partial'),
    story('inProgress', 'feature', 'partial'),
    { ...story('finished', 'story', 'inProgress'), status: 'done' },
    { ...story('merge', 'story', 'inProgress'), status: 'merging' },
    { ...story('closed', 'epic'), status: 'done' },
    story('openFeature', 'feature', 'closed'),
  ]
  const expected = [
    ['empty', 'active'],
    ['complete', 'closed'],
    ['allDone', 'closed'],
    ['manual', 'closed'],
    ['partial', 'active'],
    ['emptyFeature', 'active'],
    ['inProgress', 'active'],
    ['closed', 'closed'],
    ['openFeature', 'active'],
  ]
  const statuses = storyStatuses(board, [], {}, 'p')
  expect(
    board.filter((s) => s.kind !== 'story').map((s) => [s.id, statuses.get(s.id)?.value]),
  ).toEqual(expected)
})
test('parent status ignores its own run and follows completed child runs', () => {
  const epic = story('e', 'epic')
  const feature = { ...story('f', 'feature', 'e'), task: task.id, autoRunId: 'run' }
  const child = story('s', 'story', 'f')
  const runs = { task: { runId: 'run', status: 'done' as const } }
  const ownRun = storyStatuses([epic, feature, child], [task], runs, 'p')
  expect(ownRun.get('f')).toEqual({ value: 'active', source: 'children' })
  const childRun = storyStatuses(
    [epic, feature, { ...child, task: task.id, autoRunId: 'run' }],
    [task],
    runs,
    'p',
  )
  expect(childRun.get('f')).toEqual({ value: 'closed', source: 'children' })
  expect(childRun.get('e')).toEqual({ value: 'closed', source: 'children' })
})
test('saved Building agrees with the editor, including missing worktrees and Reopen', () => {
  const item = { ...story('s'), task: task.id, status: 'building' as const }
  expect(statusOf(item, [], {}, 'p')).toBe('building')
  expect(statusOf(item, [{ ...task, missing: true }], {}, 'p')).toBe('building')
})
test('Reopen requests an atomic backend reset and refresh skips the released Auto identity', async () => {
  const completed = {
    ...story('s'),
    task: 'task',
    autoRunId: 'run',
    status: 'done' as const,
    previousStatus: 'planned' as const,
  }
  useStore.setState({
    stories: [completed],
    activeTask: 'task',
    auto: run({ status: 'done', runId: 'run' }),
  })
  const saved = { ...completed, status: 'planned' as const, autoRunId: null, taskHead: 'new' }
  vi.mocked(ipc.storyUpdate).mockResolvedValueOnce(saved)
  const reopened = await updateStory('p', completed.id, reopenStoryPatch(completed))
  expect(ipc.storyUpdate).toHaveBeenCalledWith('p', 's', { reopen: true, autoRunId: '' })
  vi.mocked(ipc.storyList).mockResolvedValueOnce([reopened])
  await refreshStories('p')
  expect(ipc.storyCompleteAuto).not.toHaveBeenCalled()
  expect(statusOf(useStore.getState().stories[0], [], { task: run({ status: 'done' }) }, 'p')).toBe(
    'planned',
  )
})
test('Reopen preserves the matching unfinished Auto run, including in a background worktree', async () => {
  const completed = { ...story('s'), task: 'task', autoRunId: 'run', status: 'done' as const }
  for (const status of ['running', 'paused', 'waitingOnYou'] as const) {
    expect(reopenStoryPatch(completed, run({ status }))).toEqual({ reopen: true })
  }
  expect(reopenStoryPatch(completed, run({ status: 'done' }))).toEqual({
    reopen: true,
    autoRunId: '',
  })
  expect(reopenStoryPatch(completed, run({ runId: 'other' }))).toEqual({
    reopen: true,
    autoRunId: '',
  })
  const reopened = { ...completed, status: 'planned' as const }
  useStore.setState({ stories: [completed] })
  useStore.getState().patchTask('p', 'task', { auto: run() })
  vi.mocked(ipc.storyUpdate).mockResolvedValueOnce(reopened)
  await updateStory('p', completed.id, reopenStoryPatch(completed, run()))
  vi.mocked(ipc.storyCompleteAuto).mockResolvedValueOnce([{ ...reopened, status: 'done' }])
  await completeAutoStories('p', 'task', 'run')
  expect(ipc.storyCompleteAuto).toHaveBeenCalledWith('p', 'task', 'run')
  expect(useStore.getState().stories[0].status).toBe('done')
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
  expect(ipc.storyUpdate).toHaveBeenCalledWith('p', 's', {
    status: 'planned',
    expectedProgress: { status: 'backlog', task: null },
  })
  vi.mocked(startTerminal).mockRejectedValueOnce(new Error('Failed'))
  vi.mocked(ipc.storyUpdate).mockClear()
  await expect(planStory('p', item)).rejects.toThrow('Failed')
  expect(ipc.storyUpdate).not.toHaveBeenCalled()
})
test('Auto drafts carry story goals; linkage is recorded only once a run has a task', async () => {
  const item = story('s')
  useStore.setState({ stories: [item] })
  // The editor closes only when the Auto panel opens.
  expect(autoStory('other', item)).toBe(false)
  expect(autoStory('p', item)).toBe(true)
  expect(autoDrafts.get(autoDraftKey('p', null))).toMatchObject({
    story: 's',
    goal: storyGoal(item),
  })
  expect(useStore.getState().utilityPanel).toBe('auto')
  expect(ipc.storyUpdate).not.toHaveBeenCalled()
  await linkAutoStory('p', null, 's')
  expect(ipc.storyUpdate).not.toHaveBeenCalled()
  useStore.getState().patchTask('p', 'task', { auto: run({ stage: 'review' }) })
  await linkAutoStory('p', 'task', 's')
  expect(ipc.storyUpdate).toHaveBeenCalledWith('p', 's', {
    task: 'task',
    autoRunId: 'run',
    status: 'reviewing',
    expectedProgress: { status: 'backlog', task: null },
  })
  expect(useStore.getState().stories[0].status).toBe('reviewing')
})
test('Auto links completed stories and parents without saving a stage', async () => {
  useStore.setState({ stories: [{ ...story('s'), status: 'done' }, story('e', 'epic')] })
  useStore.getState().patchTask('p', 'task', { auto: run({ stage: 'review' }) })
  await linkAutoStory('p', 'task', 's')
  expect(ipc.storyUpdate).toHaveBeenLastCalledWith('p', 's', { task: 'task', autoRunId: 'run' })
  await linkAutoStory('p', 'task', 'e')
  expect(ipc.storyUpdate).toHaveBeenLastCalledWith('p', 'e', { task: 'task', autoRunId: 'run' })
})
test('Auto guards its stage with the saved board, which an agent may have advanced', async () => {
  useStore.setState({ stories: [story('s')] })
  vi.mocked(ipc.storyList).mockResolvedValueOnce([{ ...story('s'), status: 'planned' }])
  useStore.getState().patchTask('p', 'task', { auto: run({ stage: 'review' }) })
  await linkAutoStory('p', 'task', 's')
  expect(ipc.storyUpdate).toHaveBeenCalledWith('p', 's', {
    task: 'task',
    autoRunId: 'run',
    status: 'reviewing',
    expectedProgress: { status: 'planned', task: null },
  })
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
  vi.mocked(confirmAction).mockResolvedValue(false)
  vi.mocked(ipc.terminalSnapshot).mockResolvedValueOnce({ running: true } as never)
  // The editor stays open when the person keeps the running planner.
  expect(await planStory('p', story('s'))).toBe(false)
  expect(confirmAction).toHaveBeenCalledOnce()
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  expect(startTerminal).not.toHaveBeenCalled()
  vi.mocked(confirmAction).mockResolvedValue(true)
  vi.mocked(ipc.terminalSnapshot).mockResolvedValueOnce({ running: true } as never)
  expect(await planStory('p', story('s'))).toBe(true)
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
  expect(autoStory('p', story('blocked'))).toBe(true)
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
  expect(statusOf(useStore.getState().stories[0], [], {}, 'p')).toBe('done')
})

test('latest running review, merge or root record determines a live story stage', async () => {
  const { worktreeStage } = await import('./stories')
  const record = (scope: string, startedMs: number) =>
    ({
      id: `${scope}:${startedMs}`,
      metadata: {
        projectId: 'p',
        componentId: scope,
        task: task.id,
        branch: 'feature',
        kind: 'agent',
      },
      spec: { cwd: task.worktree, merge_source: task.worktree },
      snapshot: { startedMs, running: true },
    }) as unknown as import('../types').SessionRecord
  const t = { ...task, branch: 'feature' }
  const records = [record('@task', 1), record('@review', 2), record('@merge', 3)]
  expect(worktreeStage(t, 'p', records.slice(0, 2))).toBe('reviewing')
  expect(worktreeStage(t, 'p', records)).toBe('merging')
  expect(worktreeStage(t, 'p', [...records, record('@task', 4)])).toBe('building')
  expect(worktreeStage(t, 'p', [...records, record('@coordinator', 4)])).toBe('building')
  expect(worktreeStage(t, 'other', records)).toBeNull()
  expect(worktreeStage(t, 'p', [{ ...records[0], snapshot: null }])).toBeNull()
  // A finished merge leaves the saved status alone instead of reading as still merging.
  const finished = (r: (typeof records)[number]) => ({
    ...r,
    snapshot: { ...r.snapshot!, running: false },
  })
  expect(worktreeStage(t, 'p', [records[0], records[1], finished(records[2])])).toBe('reviewing')
  expect(worktreeStage(t, 'p', records.map(finished))).toBeNull()
  expect(
    worktreeStage(t, 'p', [
      { ...records[0], metadata: { ...records[0].metadata, kind: 'shell' } },
      { ...records[0], spec: { ...records[0].spec, purpose: 'chat' } },
    ]),
  ).toBeNull()
  const unrelated = {
    ...record('@review', 20),
    metadata: { ...record('@review', 20).metadata, projectId: 'other' },
  }
  expect(statusOf({ ...story('s'), task: task.id }, [t], {}, 'p', [unrelated, ...records])).toBe(
    'merging',
  )
  expect(statusOf({ ...story('s'), task: task.id }, [t], {}, 'p', records)).toBe('merging')
})
test.each([
  ['scan', 'planned'],
  ['plan', 'planned'],
  ['implement', 'building'],
  ['validate', 'building'],
  ['review', 'reviewing'],
  ['mergeGate', 'merging'],
  ['merge', 'merging'],
  ['fix', 'building'],
] as const)('Auto %s resolves to %s', (stage, expected) => {
  expect(statusOf({ ...story('s'), task: task.id }, [task], { task: run({ stage }) }, 'p')).toBe(
    expected,
  )
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
  // Only a planner that started is recorded.
  vi.mocked(startTerminal).mockResolvedValueOnce('request')
  useStore.getState().setSimpleMode(true)
  useStore.getState().setStoryBoard(true)
  // A chat the user hid opens for the new planner.
  useStore.getState().clearChatReveal()
  await planStory('p', story('Feature name'))
  expect(useStore.getState()).toMatchObject({
    simpleMode: true,
    view: 'navigation',
    storyBoard: true,
    chatReveal: { projectId: 'p', task: null },
  })
  // Recorded in the background, once its run is looked up.
  await vi.waitFor(() =>
    expect(useStore.getState().simple?.log.at(-1)).toMatchObject({
      kind: 'action',
      action: 'plan',
      text: 'Feature name',
      origin: 'chat',
    }),
  )
})
test('a replacing story planner logs its new run, and a worktree switch while stopping refuses', async () => {
  planner()
  useStore.getState().setSimpleMode(true)
  const sid = plannerSessionId('agent', 'p')
  useStore.getState().setSession(sid, { generation: 4, running: false })
  vi.mocked(confirmAction).mockResolvedValue(true)
  vi.mocked(ipc.terminalSnapshot)
    .mockResolvedValueOnce({ running: true } as never)
    .mockResolvedValueOnce({ running: false } as never)
  // The run the story's launch request started, whatever the clocks say.
  vi.mocked(startTerminal).mockResolvedValueOnce('request')
  vi.mocked(ipc.sessionsList).mockResolvedValueOnce([
    { id: sid, snapshot: { running: true, generation: 5, startedMs: 1 }, requestIds: ['request'] },
  ] as never)
  await planStory('p', story('Feature name'))
  await vi.waitFor(() =>
    expect(useStore.getState().simple?.log.at(-1)).toMatchObject({ sessionId: sid, generation: 5 }),
  )
  vi.mocked(ipc.terminalSnapshot)
    .mockResolvedValueOnce({ running: true } as never)
    .mockImplementationOnce(async () => {
      useStore.setState({ activeTask: 'other' })
      return { running: false } as never
    })
  await expect(planStory('p', story('Feature name'))).rejects.toThrow('The worktree changed')
  vi.unstubAllGlobals()
})

test('board order matches the core golden order', () => {
  // Paired with core `stories::tests::golden_board`; keep the two fixtures identical.
  const at = (
    id: string,
    kind: Story['kind'],
    parent: string | null,
    order: number,
    createdMs: number,
  ) => ({
    ...story(id, kind, parent, order),
    createdMs,
  })
  const board = [
    at('s1', 'story', null, 1, 1),
    at('e2', 'epic', null, 2, 2),
    at('e1', 'epic', null, 1, 3),
    at('f2', 'feature', 'e1', 0, 4),
    at('f1', 'feature', 'e1', 0, 3),
    at('f3', 'feature', 'e2', 0, 5),
    at('a2', 'story', 'f1', 5, 6),
    at('a1', 'story', 'f1', 5, 6),
    at('b1', 'story', 'f2', 0, 7),
    at('c1', 'story', 'f3', 0, 8),
    at('o1', 'story', 'gone', 0, 9),
    at('s0', 'story', null, 0, 10),
  ]
  expect(boardOrder(board).map((s) => s.id)).toEqual([
    'e1',
    'f1',
    'a1',
    'a2',
    'f2',
    'b1',
    'e2',
    'f3',
    'c1',
    'o1',
    's0',
    's1',
  ])
})

test('reorder moves an item only among its siblings', () => {
  const board = [
    story('e', 'epic'),
    story('f', 'feature', 'e'),
    story('a', 'story', 'f', 0),
    story('b', 'story', 'f', 1),
    story('c', 'story', 'f', 2),
    story('loose', 'story', null, 0),
    story('orphan', 'story', 'gone', 1),
  ]
  expect(siblings(board, board[2]).map((s) => s.id)).toEqual(['a', 'b', 'c'])
  expect(siblings(board, board[5]).map((s) => s.id)).toEqual(['loose', 'orphan'])
  expect(reorder(board, 'c', 'a')).toEqual(['c', 'a', 'b'])
  expect(reorder(board, 'a', 'c')).toEqual(['b', 'a', 'c'])
  expect(reorder(board, 'a', null)).toEqual(['b', 'c', 'a'])
  expect(reorder(board, 'orphan', 'loose')).toEqual(['orphan', 'loose'])
  // Unchanged positions, the item itself and other groups move nothing.
  expect(reorder(board, 'a', 'b')).toBeUndefined()
  expect(reorder(board, 'c', null)).toBeUndefined()
  expect(reorder(board, 'a', 'a')).toBeUndefined()
  expect(reorder(board, 'a', 'loose')).toBeUndefined()
  expect(reorder(board, 'missing', null)).toBeUndefined()
  // A column's groups: a story under an epic-less feature is shown, and ordered, as unassigned.
  const loose = [story('lost', 'feature', null), story('x', 'story', 'lost'), story('y', 'story')]
  expect(siblings(loose, loose[1]).map((s) => s.id)).toEqual(['x', 'y'])
})

test('quick moves save one at a time, in the order they were made', async () => {
  const board = [
    story('a', 'story', null, 0),
    story('b', 'story', null, 1),
    story('c', 'story', null, 2),
  ]
  useStore.getState().patchProject('p', { stories: board })
  let release = () => {}
  vi.mocked(ipc.storyReorder).mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  )
  const first = moveStory('p', 'c', 'b')
  const second = moveStory('p', 'c', 'a')
  await Promise.resolve()
  expect(ipc.storyReorder).toHaveBeenCalledTimes(1)
  release()
  await Promise.all([first, second])
  expect(vi.mocked(ipc.storyReorder).mock.calls.map((c) => c[1])).toEqual([
    ['a', 'c', 'b'],
    ['c', 'a', 'b'],
  ])
})

test('a story planner keeps only components still on the map, else the worktree highlights', async () => {
  const planned = story('s')
  await launchStoryPlanner('p', 'task', 'planner', planned, ['api', 'removed'])
  expect(vi.mocked(startTerminal).mock.lastCall?.[4]).toMatchObject({ components: ['api'] })
  await launchStoryPlanner('p', 'task', 'planner', planned, ['removed'])
  expect(vi.mocked(startTerminal).mock.lastCall?.[4]?.components).toBeUndefined()
})

test('a story planner sends the goal and still returns its launch when marking Planned fails', async () => {
  vi.mocked(startTerminal).mockResolvedValueOnce('req')
  vi.mocked(ipc.storyUpdate).mockRejectedValueOnce(new Error('gone'))
  await expect(
    launchStoryPlanner('p', 'task', 'planner', story('s'), [], ' Skip CSV '),
  ).resolves.toBe('req')
  expect(vi.mocked(startTerminal).mock.lastCall?.[4]).toMatchObject({ planRequest: 'Skip CSV' })
  expect(useStore.getState().message).toContain('could not be marked Planned')
})

test('a refresh that read the board before a move saved never restores the old order', async () => {
  const board = [story('a', 'story', null, 0), story('b', 'story', null, 1)]
  useStore.getState().patchProject('p', { stories: board })
  let release = () => {}
  vi.mocked(ipc.storyReorder).mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  )
  let read = (_: typeof board) => {}
  vi.mocked(ipc.storyList).mockImplementationOnce(() => new Promise((resolve) => (read = resolve)))
  const move = moveStory('p', 'b', 'a')
  const refresh = refreshStories('p')
  await vi.waitFor(() => expect(ipc.storyReorder).toHaveBeenCalled())
  release()
  await move
  read(board)
  await refresh
  expect(boardOrder(projectStateOf('p')!.stories).map((s) => s.id)).toEqual(['b', 'a'])
})

test('moveStory shows the new order at once and reloads when the save fails', async () => {
  const board = [story('a', 'story', null, 0), story('b', 'story', null, 1)]
  useStore.getState().patchProject('p', { stories: board })
  await moveStory('p', 'b', 'a')
  expect(ipc.storyReorder).toHaveBeenCalledWith('p', ['b', 'a'])
  expect(boardOrder(projectStateOf('p')!.stories).map((s) => s.id)).toEqual(['b', 'a'])
  vi.mocked(ipc.storyReorder).mockRejectedValueOnce(new Error('The board changed'))
  vi.mocked(ipc.storyList).mockResolvedValueOnce(board)
  await moveStory('p', 'a', 'b')
  expect(boardOrder(projectStateOf('p')!.stories).map((s) => s.id)).toEqual(['a', 'b'])
  expect(useStore.getState().message).toContain('The board changed')
})

const scopeItems = [
  story('e1', 'epic'),
  story('e2', 'epic', null, 1),
  story('f1', 'feature', 'e1'),
  story('f2', 'feature', 'e2'),
  story('s1', 'story', 'f1'),
  story('s2', 'story', 'f2'),
  story('loose'),
]
const ids = (items: Story[]) => items.map((s) => s.id)

test('board scope shows everything with nothing chosen', () => {
  const scope = boardScope(tree(scopeItems), null, null)
  expect(scope.narrowed).toBe(false)
  expect(ids(scope.features)).toEqual(['f1', 'f2'])
  expect(ids(scope.stories)).toEqual(['s1', 's2', 'loose'])
})

test('board scope narrows features and stories to a chosen epic', () => {
  const scope = boardScope(tree(scopeItems), 'e1', null)
  expect(scope.epic?.id).toBe('e1')
  expect(scope.path?.id).toBe('e1')
  expect(scope.feature).toBeNull()
  expect(ids(scope.features)).toEqual(['f1'])
  expect(ids(scope.stories)).toEqual(['s1'])
})

test('board scope names a chosen feature with its epic as context', () => {
  const scope = boardScope(tree(scopeItems), null, 'f2')
  expect(scope.epic).toBeNull()
  expect(scope.path?.id).toBe('e2')
  expect(scope.feature?.id).toBe('f2')
  expect(ids(scope.features)).toEqual(['f1', 'f2'])
  expect(ids(scope.stories)).toEqual(['s2'])
})

test('board scope shows unassigned stories on their own', () => {
  const scope = boardScope(tree(scopeItems), null, UNASSIGNED)
  expect(scope.unassigned).toBe(true)
  expect(scope.narrowed).toBe(true)
  expect(ids(scope.stories)).toEqual(['loose'])
})

test('board scope drops ids that no longer exist or sit outside the chosen epic', () => {
  expect(boardScope(tree(scopeItems), 'gone', 'gone').narrowed).toBe(false)
  const scope = boardScope(tree(scopeItems), 'e1', 'f2')
  expect(scope.feature).toBeNull()
  expect(ids(scope.stories)).toEqual(['s1'])
})

test('search matches every term across title, description, criteria and tracker id', () => {
  const items: Story[] = [
    { ...story('title'), title: 'Login Page' },
    { ...story('description'), description: 'Reset a forgotten password' },
    { ...story('criteria'), acceptance: ['Shows an error toast'] },
    { ...story('tracker'), source: { extension: 'github', externalId: 'owner/repo#42' } },
  ]
  expect(searchStories(items, '')).toBe(items)
  expect(searchStories(items, '   ')).toBe(items)
  expect(searchStories(items, 'login').map((s) => s.id)).toEqual(['title'])
  expect(searchStories(items, 'PAGE login').map((s) => s.id)).toEqual(['title'])
  expect(searchStories(items, 'login reset')).toEqual([])
  expect(searchStories(items, 'forgotten').map((s) => s.id)).toEqual(['description'])
  expect(searchStories(items, 'toast').map((s) => s.id)).toEqual(['criteria'])
  expect(searchStories(items, 'repo#42').map((s) => s.id)).toEqual(['tracker'])
})
