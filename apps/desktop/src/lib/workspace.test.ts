import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import { MAX_SUBAGENTS, MIN_SUBAGENTS, SUBAGENT_COUNTS } from '../types'
vi.mock('./ipc', () => ({ quitPatchbay: vi.fn(), workspaceLoad: vi.fn(), workspaceSave: vi.fn() }))
vi.mock('./windows', () => ({ openComponentWindow: vi.fn() }))
vi.mock('./sessions', () => ({ reconcileSessions: vi.fn() }))
const { workspaceDocument, restoredLayout } = await import('./workspace')
beforeEach(() => {
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    root: '/p',
    name: 'P',
    schemaVersion: 4,
    links: [],
    components: ['a', 'b', 'c'].map((id) => ({
      id,
      name: id,
      path: id,
      kind: 'app',
      notes: '',
      terminals: [],
      position: { x: 0, y: 0 },
    })),
  })
})
test('pills and groups retain one order when toggled through Plan', () => {
  const s = useStore.getState()
  s.toggleHighlight('b')
  s.toggleHighlight('a')
  s.toggleHighlight('b')
  expect(useStore.getState().implementationComponents).toEqual([
    { id: 'b', visible: false },
    { id: 'a', visible: true },
  ])
  s.toggleHighlight('b')
  expect(useStore.getState().highlighted).toEqual(['b', 'a'])
})
test('entering Implementation leaves highlights, the task scope, alone', () => {
  const s = useStore.getState()
  s.setImplementationScope([])
  s.select('c')
  s.setView('implementation')
  expect(useStore.getState().highlighted).toEqual([])
  expect(useStore.getState().implementationComponents).toEqual([])
})
test('workspace round-trip preserves hidden entries, removal, order and visibility', () => {
  const components = [
    { id: 'c', visible: false },
    { id: 'a', visible: true },
  ]
  useStore.getState().setImplementationScope(components)
  const layout = workspaceDocument().projects[0].layout
  expect(restoredLayout(layout).implementationComponents).toEqual(components)
  expect(restoredLayout(layout).highlighted).toEqual(['a'])
  useStore.getState().setImplementationScope([])
  expect(restoredLayout(workspaceDocument().projects[0].layout).implementationComponents).toEqual(
    [],
  )
})
test('legacy layouts retain fallback and malformed entries are ignored', () => {
  expect(restoredLayout({ highlighted: ['a'] }).implementationComponents).toBeUndefined()
  expect(
    restoredLayout({
      implementationComponents: [
        null,
        3,
        {},
        { id: 'b', visible: false },
        { id: 'b', visible: true },
      ],
    }).implementationComponents,
  ).toEqual([{ id: 'b', visible: false }])
})

test('Auto persists per worktree without dirtying the map and restores paused', () => {
  const run = {
    runId: 'run',
    status: 'running' as const,
    stage: 'review' as const,
    goal: 'Ship the task',
    effort: 'light' as const,
    merge: { mode: 'ask' as const, destinationBranch: 'main' },
    device: 'codex',
    round: 1,
    sessionId: 'old-session',
    sessionOwned: true,
    sessionStartedMs: 5,
    log: [{ atMs: 1, text: 'Review' }],
  }
  useStore.getState().patchTask('p', null, { auto: run })
  expect(useStore.getState().dirty).toBe(false)
  const layout = restoredLayout(workspaceDocument().projects[0].layout)
  expect(layout.auto).toMatchObject({ status: 'paused', stage: 'review', round: 1 })
  // Its agent keeps running in the session service, so Auto still tracks and owns it.
  expect(layout.auto).toMatchObject({
    sessionId: 'old-session',
    sessionOwned: true,
    sessionStartedMs: 5,
  })
  expect(layout.taskWorkspaces?.[''].auto?.status).toBe('paused')
  expect(restoredLayout({ auto: { ...run, overrides: { maxRounds: -1 } } }).auto).toBeNull()
  // Finished runs stay finished, so a new run can start without Stop.
  for (const status of ['done', 'stopped', 'failed'] as const)
    expect(restoredLayout({ auto: { ...run, status, reason: 'Finished' } }).auto).toMatchObject({
      status,
      reason: 'Finished',
    })
})

test('notification settings stay global, persist without projects and never dirty the map', () => {
  const settings = { enabled: false, finished: true, needsInput: false, failed: true }
  expect(useStore.getState().dirty).toBe(false)
  useStore.getState().setNotifications(settings)
  expect(workspaceDocument().settings).toEqual({ notifications: settings })
  expect(useStore.getState().dirty).toBe(false)
  expect(workspaceDocument().projects[0].layout).not.toHaveProperty('notifications')
  useStore.getState().loadProject({
    projectId: 'second',
    root: '/second',
    name: 'Second',
    schemaVersion: 4,
    links: [],
    components: [],
  })
  expect(useStore.getState().notifications).toEqual(settings)
  useStore.getState().closeProject('second')
  useStore.getState().closeProject('p')
  expect(workspaceDocument().settings).toEqual({ notifications: settings })
})

test('saving notifications retains opaque workspace settings', () => {
  const workspaceSettings = {
    future: 42,
    nested: { untouched: true },
    notifications: { enabled: false },
  }
  useStore.setState({ workspaceSettings })
  const notifications = { ...useStore.getState().notifications, needsInput: false }
  useStore.getState().setNotifications(notifications)
  expect(workspaceDocument().settings).toEqual({ ...workspaceSettings, notifications })
  expect(workspaceSettings.notifications).toEqual({ enabled: false })
})

test('showing and dismissing notifications preserves persistent errors', () => {
  useStore.getState().setMessage('Could not save the workspace')
  const original = useStore.getState().messageId
  useStore.getState().setNotificationToast({ message: 'Agent finished', sessions: [] })
  expect(useStore.getState()).toMatchObject({
    message: 'Could not save the workspace',
    messageId: original,
    messageTransient: false,
    notificationToast: { message: 'Agent finished', sessions: [] },
  })
  useStore.getState().setNotificationToast(null)
  expect(useStore.getState()).toMatchObject({
    message: 'Could not save the workspace',
    messageId: original,
    messageTransient: false,
  })
})
test('a layout saved with the retired plannedFromProject flag restores without it', () => {
  const layout = restoredLayout({
    activeTask: 'old',
    plannedFromProject: true,
    taskWorkspaces: { old: { plannedFromProject: true }, '': {} },
  })
  expect(layout.activeTask).toBe('old')
  expect(layout).not.toHaveProperty('plannedFromProject')
  expect(layout.taskWorkspaces?.old).not.toHaveProperty('plannedFromProject')
})

test('Implement subagents restore Off or supported integer counts', () => {
  expect(SUBAGENT_COUNTS).toEqual([0, 2, 3, 4, 5, 6, 7, 8])
  for (const implementSubagents of SUBAGENT_COUNTS)
    expect(restoredLayout({ implementSubagents }).implementSubagents).toBe(implementSubagents)
  for (const implementSubagents of [
    undefined,
    null,
    '3',
    true,
    -1,
    MIN_SUBAGENTS - 1,
    MAX_SUBAGENTS + 1,
    MIN_SUBAGENTS + 0.5,
    NaN,
    Infinity,
    {},
  ])
    expect(restoredLayout({ implementSubagents }).implementSubagents).toBe(0)
  const restored = restoredLayout({
    implementSubagents: 3,
    taskWorkspaces: { other: { implementSubagents: 7 } },
  })
  expect(restored.taskWorkspaces?.other).not.toHaveProperty('implementSubagents')
  expect(restored.taskWorkspaces?.['']).not.toHaveProperty('implementSubagents')
})

test('Implement subagents persist per project without dirtying the map', () => {
  const firstProject = useStore.getState().toProject()
  useStore.getState().setImplementSubagents(3)
  expect(useStore.getState().dirty).toBe(false)
  expect(useStore.getState().toProject()).toEqual(firstProject)
  const layout = workspaceDocument().projects[0].layout
  expect(restoredLayout(layout).implementSubagents).toBe(3)
  useStore.getState().loadProject({
    projectId: 'second',
    root: '/second',
    name: 'Second',
    schemaVersion: 4,
    links: [],
    components: [],
  })
  expect(useStore.getState().implementSubagents).toBe(0)
  useStore.getState().setImplementSubagents(5)
  useStore.getState().activateProject('p')
  expect(useStore.getState().implementSubagents).toBe(3)
  expect(workspaceDocument().projects[1].layout.implementSubagents).toBe(5)
})

test('declining dependency detection persists per project without dirtying the map', () => {
  const firstProject = useStore.getState().toProject()
  useStore.getState().patchProject('p', { dependencyPromptDismissed: true })
  expect(useStore.getState().dirty).toBe(false)
  expect(useStore.getState().toProject()).toEqual(firstProject)
  const layout = workspaceDocument().projects[0].layout
  expect(restoredLayout(layout).dependencyPromptDismissed).toBe(true)
  expect(restoredLayout({}).dependencyPromptDismissed).toBe(false)
  expect(restoredLayout({ dependencyPromptDismissed: 'yes' }).dependencyPromptDismissed).toBe(false)
  const restored = restoredLayout({
    dependencyPromptDismissed: true,
    taskWorkspaces: { other: { dependencyPromptDismissed: true } },
  })
  expect(restored.taskWorkspaces?.other).not.toHaveProperty('dependencyPromptDismissed')
})

test('Simple defaults off, preserves the Full view and restores the complete worktree log', () => {
  expect(restoredLayout({}).simpleMode).toBe(false)
  expect(restoredLayout({}).simple).toBeNull()
  const s = useStore.getState()
  s.setView('review')
  s.setSimpleMode(true)
  expect(useStore.getState().view).toBe('review')
  const simple = {
    startedMs: 1,
    log: [
      {
        id: 'one',
        atMs: 2,
        stage: 'plan' as const,
        kind: 'prompt' as const,
        text: ' exact\n ',
        mentions: ['a'],
      },
    ],
  }
  useStore.setState({ simple, dirty: false })
  const restored = restoredLayout(workspaceDocument().projects[0].layout)
  expect(restored.simpleMode).toBe(true)
  expect(restored.simple).toEqual(simple)
  expect(restored.taskWorkspaces?.[''].simple).toEqual(simple)
  s.setView('implementation')
  expect(useStore.getState().simpleMode).toBe(false)
  expect(useStore.getState().dirty).toBe(false)
})

test('story board and planner story persist per project, outside task layouts and map dirtiness', () => {
  useStore.getState().select('a')
  useStore.getState().setStoryBoard(true)
  useStore.setState({ planStory: 'story1', planStoryTerminal: 'claude' })
  expect(useStore.getState()).toMatchObject({
    selectedId: null,
    selectedEdgeId: null,
    view: 'navigation',
    dirty: false,
  })
  const layout = restoredLayout(workspaceDocument().projects[0].layout)
  expect(layout).toMatchObject({
    storyBoard: true,
    planStory: 'story1',
    planStoryTerminal: 'claude',
  })
  expect(layout.taskWorkspaces?.['']).not.toHaveProperty('storyBoard')
  expect(layout.taskWorkspaces?.['']).not.toHaveProperty('planStory')
  expect(workspaceDocument().projects[0]).not.toHaveProperty('stories')
  expect(restoredLayout({ storyBoard: 'true', planStory: 3 })).toMatchObject({
    storyBoard: false,
    planStory: null,
  })
  useStore.getState().loadProject({
    projectId: 'q',
    root: '/q',
    name: 'Q',
    schemaVersion: 4,
    components: [],
    links: [],
  })
  expect(useStore.getState().storyBoard).toBe(false)
  useStore.getState().activateProject('p')
  expect(useStore.getState().storyBoard).toBe(true)
})
