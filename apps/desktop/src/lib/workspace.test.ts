import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
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
  expect(restoredLayout({}).closedTaskIds).toEqual([])
  expect(restoredLayout({ closedTaskIds: ['one', null, 4, 'one', 'two'] }).closedTaskIds).toEqual([
    'one',
    'two',
  ])
  expect(restoredLayout({ closedTaskIds: 'one' }).closedTaskIds).toEqual([])
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
    log: [{ atMs: 1, text: 'Review' }],
  }
  useStore.getState().patchTask('p', null, { auto: run })
  expect(useStore.getState().dirty).toBe(false)
  const layout = restoredLayout(workspaceDocument().projects[0].layout)
  expect(layout.auto).toMatchObject({ status: 'paused', stage: 'review', round: 1 })
  expect(layout.auto?.sessionId).toBeUndefined()
  expect(layout.taskWorkspaces?.[''].auto?.status).toBe('paused')
  expect(restoredLayout({ auto: { ...run, overrides: { maxRounds: -1 } } }).auto).toBeNull()
})
