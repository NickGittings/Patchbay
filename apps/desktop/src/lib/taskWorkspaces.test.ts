import { beforeEach, expect, test, vi } from 'vitest'
import { emptyTaskWorkspace, useStore } from '../store'
import { sessionId, TASK_ROOT_SCOPE, type Task } from '../types'
import { taskTerminals, visibleTaskTerminals } from './taskTerminals'
vi.mock('./ipc', () => ({ quitPatchbay: vi.fn(), workspaceLoad: vi.fn(), workspaceSave: vi.fn() }))
vi.mock('./windows', () => ({ openComponentWindow: vi.fn() }))
vi.mock('./sessions', () => ({ reconcileSessions: vi.fn() }))
const { workspaceDocument, restoredLayout } = await import('./workspace')
const task = (id: string, components: string[] = ['web']): Task => ({
  id,
  title: id,
  worktree: `/p-${id}`,
  branch: id,
  components,
  notes: '',
  createdMs: 1,
  missing: false,
  current: false,
})
beforeEach(() => {
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    name: 'P',
    root: '/p',
    schemaVersion: 4,
    links: [],
    components: [
      {
        id: 'web',
        name: 'Web',
        path: '.',
        kind: 'app',
        notes: '',
        position: { x: 0, y: 0 },
        terminals: [{ id: 'dev', name: 'Dev', command: 'dev', kind: 'task' }],
      },
    ],
  })
  useStore.getState().setTasks([task('one'), task('two', [])])
})
test('switching restores scope, root terminals, visibility, focus and splits independently', () => {
  const s = useStore.getState()
  s.setActiveTask('one')
  s.addRootTerminal(null)
  const root = useStore.getState().rootTerminals
  const focused = sessionId(TASK_ROOT_SCOPE, root[1].id, 'one', 'p')
  s.setActiveSession(focused)
  s.setVisibleTerminals([focused])
  s.setMaximizedTerminal(focused)
  s.setPanelLayout('split', { a: 70, b: 30 })
  s.setActiveTask('two')
  expect(useStore.getState().highlighted).toEqual([])
  expect(useStore.getState().activeSession).toBeNull()
  expect(useStore.getState().rootTerminals).toHaveLength(1)
  s.setImplementationScope([])
  s.setActiveTask('one')
  expect(useStore.getState().rootTerminals).toEqual(root)
  expect(useStore.getState().activeSession).toBe(focused)
  expect(useStore.getState().visibleTerminals).toEqual([focused])
  expect(useStore.getState().maximizedTerminal).toBe(focused)
  expect(useStore.getState().panels.split).toEqual({ a: 70, b: 30 })
  expect(useStore.getState().highlighted).toEqual(['web'])
})
test('legacy state migrates to its active task and task layouts survive reopening', () => {
  const legacy = restoredLayout({
    activeTask: 'one',
    highlighted: ['web'],
    activeSession: 'legacy-session',
    panels: { split: { a: 40, b: 60 } },
  })
  useStore.setState(legacy)
  useStore.getState().setActiveTask('two')
  const restored = restoredLayout(workspaceDocument().projects[0].layout)
  useStore.setState(restored)
  useStore.getState().setActiveTask('one')
  expect(useStore.getState().activeSession).toBe('legacy-session')
  expect(useStore.getState().highlighted).toEqual(['web'])
  expect(useStore.getState().panels.split.a).toBe(40)
})
test('assigned project checkout has one workspace and unavailable tasks cannot activate', () => {
  const s = useStore.getState()
  s.setTasks([
    { ...task('current'), current: true },
    { ...task('missing'), missing: true },
  ])
  expect(useStore.getState().activeTask).toBe('current')
  s.setActiveTask(null)
  expect(useStore.getState().activeTask).toBe('current')
  s.setActiveTask('missing')
  expect(useStore.getState().activeTask).toBe('current')
  s.setActiveTask('unknown')
  expect(useStore.getState().activeTask).toBe('current')
})
test('late results update the initiating task in a background project', () => {
  const s = useStore.getState()
  s.setActiveTask('one')
  s.patchTask('p', 'one', { graphActionBusy: true })
  s.setActiveTask('two')
  const report = {
    plan: {
      projectId: 'p',
      task: 'one',
      request: { kind: 'validateAffected' as const, componentId: 'web' },
      stages: [['web']],
      skipped: ['web'],
      sessions: [],
    },
    results: [],
  }
  s.loadProject({
    projectId: 'q',
    root: '/q',
    name: 'Q',
    schemaVersion: 4,
    links: [],
    components: [],
  })
  s.patchTask('p', 'one', { graphActionBusy: false, graphActionReport: report })
  expect(useStore.getState().graphActionReport).toBeNull()
  s.activateProject('p')
  expect(useStore.getState().activeTask).toBe('two')
  expect(useStore.getState().graphActionReport).toBeNull()
  s.setActiveTask('one')
  expect(useStore.getState().graphActionReport).toEqual(report)
  expect(useStore.getState().graphActionBusy).toBe(false)
})
test('terminal visibility includes root and task runtimes without another task or duplicates', () => {
  const workspace = emptyTaskWorkspace(['web'])
  const sid = sessionId('web', 'dev', 'one', 'p')
  const rootSid = sessionId(TASK_ROOT_SCOPE, 'shell', 'one', 'p')
  const runtime = {
    projectId: 'p',
    taskId: 'one',
    componentId: 'web',
    terminal: { id: 'extra', name: 'Extra', kind: 'task' as const, command: 'run' },
  }
  const entries = taskTerminals(
    workspace,
    useStore.getState().nodes,
    {
      [sid]: { ...runtime, terminal: useStore.getState().nodes[0].data.terminals[0] },
      extra: runtime,
      other: { ...runtime, taskId: 'two' },
      foreign: { ...runtime, projectId: 'q' },
    },
    'p',
    'one',
  )
  expect(entries.map((e) => e.sid)).toEqual([rootSid, sid, 'extra'])
  expect(visibleTaskTerminals(entries, [sid], null).map((e) => e.sid)).toEqual([sid])
  expect(visibleTaskTerminals(entries, null, rootSid).map((e) => e.sid)).toEqual([rootSid])
  expect(visibleTaskTerminals(entries, [], rootSid)).toEqual([])
  useStore.getState().setMaximizedTerminal(rootSid)
  useStore.getState().setVisibleTerminals([sid])
  expect(useStore.getState().maximizedTerminal).toBeNull()
})
