import { beforeEach, expect, test, vi } from 'vitest'
import { emptyTaskWorkspace, reconcileTaskList, switchTaskWorkspace, useStore } from '../store'
import { sessionId, TASK_ROOT_SCOPE, type Task } from '../types'
import { shownTaskTerminals, taskTerminals } from './taskTerminals'
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
test('switching restores scope, task terminals, focus and splits independently', () => {
  const s = useStore.getState()
  s.setActiveTask('one')
  s.addRootTerminal(null)
  const root = useStore.getState().rootTerminals
  const focused = sessionId(TASK_ROOT_SCOPE, root[1].id, 'one', 'p')
  s.setActiveSession(focused)
  s.addTaskComponentTerminal('web', 'dev')
  s.setActiveSession(focused)
  s.setMaximizedTerminal(focused)
  s.setPanelLayout('split', { a: 70, b: 30 })
  s.setActiveTask('two')
  expect(useStore.getState().highlighted).toEqual([])
  expect(useStore.getState().activeSession).toBeNull()
  expect(useStore.getState().rootTerminals).toHaveLength(1)
  expect(useStore.getState().componentTerminals).toEqual([])
  s.setImplementationScope([])
  s.setActiveTask('one')
  expect(useStore.getState().rootTerminals).toEqual(root)
  expect(useStore.getState().activeSession).toBe(focused)
  expect(useStore.getState().componentTerminals).toEqual([
    { componentId: 'web', terminalId: 'dev' },
  ])
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

test('closing the active tab preserves its task, processes, focus and layout for reopening', () => {
  const s = useStore.getState()
  s.setActiveTask('one')
  const rootId = s.addRootTerminal(null)
  s.addTaskComponentTerminal('web', 'dev')
  const sid = sessionId(TASK_ROOT_SCOPE, rootId, 'one', 'p')
  s.setActiveSession(sid)
  s.setMaximizedTerminal(sid)
  s.setPanelLayout('split', { a: 70, b: 30 })
  s.setSession(sid, { running: true })
  const before = useStore.getState()
  s.closeTaskTab('one')
  expect(useStore.getState().activeTask).toBe('two')
  expect(useStore.getState().closedTaskIds).toEqual(['one'])
  expect(useStore.getState().tasks).toBe(before.tasks)
  expect(useStore.getState().sessions).toBe(before.sessions)
  expect(useStore.getState().dirty).toBe(false)
  s.setActiveTask('one')
  const reopened = useStore.getState()
  expect(reopened.closedTaskIds).toEqual([])
  expect(reopened.rootTerminals).toEqual(before.rootTerminals)
  expect(reopened.componentTerminals).toEqual(before.componentTerminals)
  expect(reopened.highlighted).toEqual(before.highlighted)
  expect(reopened.activeSession).toBe(sid)
  expect(reopened.maximizedTerminal).toBe(sid)
  expect(reopened.panels.split).toEqual({ a: 70, b: 30 })
})

test('closing an inactive or unavailable tab keeps the active workspace selected', () => {
  const s = useStore.getState()
  s.setTasks([task('one'), { ...task('two'), missing: true }])
  s.setActiveTask('one')
  const before = useStore.getState()
  s.closeTaskTab('two')
  s.closeTaskTab('two')
  s.closeTaskTab('unknown')
  expect(useStore.getState().activeTask).toBe('one')
  expect(useStore.getState().closedTaskIds).toEqual(['two'])
  expect(useStore.getState().rootTerminals).toBe(before.rootTerminals)
  expect(useStore.getState().taskWorkspaces).toBe(before.taskWorkspaces)
  s.setActiveTask('two')
  expect(useStore.getState().closedTaskIds).toEqual(['two'])
})

test('closing chooses the next visible available tab, then previous, then main', () => {
  const s = useStore.getState()
  s.setTasks([task('one'), { ...task('missing'), missing: true }, task('two'), task('three')])
  s.closeTaskTab('three')
  s.setActiveTask('one')
  s.closeTaskTab('one')
  expect(useStore.getState().activeTask).toBe('two')
  s.closeTaskTab('two')
  expect(useStore.getState().activeTask).toBeNull()
  s.setActiveTask('one')
  s.setActiveTask('two')
  s.closeTaskTab('two')
  expect(useStore.getState().activeTask).toBe('one')
})

test('the named current checkout stays pinned and is selected after the last task closes', () => {
  const s = useStore.getState()
  s.setTasks([{ ...task('current'), current: true }, task('one')])
  s.closeTaskTab('current')
  expect(useStore.getState().closedTaskIds).toEqual([])
  s.setActiveTask('one')
  s.closeTaskTab('one')
  expect(useStore.getState().activeTask).toBe('current')
})

test('task refresh retains closed tabs, prunes removed ids and reveals the current checkout', () => {
  const s = useStore.getState()
  s.closeTaskTab('one')
  s.closeTaskTab('two')
  s.setTasks([task('one'), task('two'), task('new')])
  expect(useStore.getState().closedTaskIds).toEqual(['one', 'two'])
  s.setTasks([task('two'), task('new')])
  expect(useStore.getState().closedTaskIds).toEqual(['two'])
  s.setTasks([{ ...task('two'), current: true }, task('new')])
  expect(useStore.getState().closedTaskIds).toEqual([])
  expect(useStore.getState().activeTask).toBe('two')
})

test('closed tabs persist per project across workspace restoration and background updates', () => {
  const s = useStore.getState()
  s.setActiveTask('one')
  s.closeTaskTab('one')
  s.setActiveTask('two')
  const layout = workspaceDocument().projects[0].layout
  useStore.setState(restoredLayout(layout))
  s.setTasks([task('one'), task('two')])
  expect(useStore.getState().closedTaskIds).toEqual(['one'])
  expect(useStore.getState().taskWorkspaces.one).not.toHaveProperty('closedTaskIds')
  s.loadProject({
    projectId: 'q',
    root: '/q',
    name: 'Q',
    schemaVersion: 4,
    links: [],
    components: [],
  })
  s.setTasks([task('one'), task('two')])
  s.closeTaskTab('two')
  expect(useStore.getState().closedTaskIds).toEqual(['two'])
  const background = s.captureProjects().p.state!
  s.patchProject('p', reconcileTaskList(background, [task('one'), task('two')]))
  expect(s.captureProjects().p.state!.closedTaskIds).toEqual(['one'])
  s.patchProject('p', switchTaskWorkspace(s.captureProjects().p.state!, 'one'))
  expect(useStore.getState().closedTaskIds).toEqual(['two'])
  s.activateProject('p')
  expect(useStore.getState().closedTaskIds).toEqual([])
  expect(useStore.getState().activeTask).toBe('one')
  s.closeTaskTab('two')
  s.loadProject({
    projectId: 'r',
    root: '/r',
    name: 'R',
    schemaVersion: 4,
    links: [],
    components: [],
  })
  s.patchProject('p', reconcileTaskList(s.captureProjects().p.state!, [task('one')]))
  s.activateProject('p')
  expect(useStore.getState().closedTaskIds).toEqual([])
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
test('a task lists its own and added terminals, plus sessions running in its worktree', () => {
  // Highlighting a component alone adds none of its terminals.
  const workspace = emptyTaskWorkspace(['web'])
  const nodes = useStore.getState().nodes
  const sid = sessionId('web', 'dev', 'one', 'p')
  const rootSid = sessionId(TASK_ROOT_SCOPE, 'shell', 'one', 'p')
  expect(taskTerminals(workspace, nodes, {}, 'p', 'one').map((e) => e.sid)).toEqual([rootSid])
  const added = { ...workspace, componentTerminals: [{ componentId: 'web', terminalId: 'dev' }] }
  expect(taskTerminals(added, nodes, {}, 'p', 'one').map((e) => e.sid)).toEqual([rootSid, sid])
  const running = { [sid]: { running: true } as never }
  expect(taskTerminals(workspace, nodes, {}, 'p', 'one', running).map((e) => e.sid)).toEqual([
    rootSid,
    sid,
  ])
  expect(taskTerminals(workspace, nodes, {}, 'p', 'two', running).map((e) => e.sid)).toEqual([
    sessionId(TASK_ROOT_SCOPE, 'shell', 'two', 'p'),
  ])
  const runtime = {
    projectId: 'p',
    taskId: 'one',
    componentId: 'web',
    terminal: { id: 'extra', name: 'Extra', kind: 'task' as const, command: 'run' },
  }
  const entries = taskTerminals(
    added,
    nodes,
    {
      [sid]: { ...runtime, terminal: nodes[0].data.terminals[0] },
      extra: runtime,
      other: { ...runtime, taskId: 'two' },
      foreign: { ...runtime, projectId: 'q' },
      exited: runtime,
    },
    'p',
    'one',
    {
      extra: { running: true } as never,
      other: { running: true } as never,
      foreign: { running: true } as never,
      exited: { running: false } as never,
    },
  )
  // A session the map no longer names shows only while it runs, or it would never go away.
  expect(entries.map((e) => e.sid)).toEqual([rootSid, sid, 'extra'])
  expect(shownTaskTerminals(entries, rootSid).map((e) => e.sid)).toEqual([rootSid])
  expect(shownTaskTerminals(entries, 'gone')).toEqual(entries)
})

test('adding and removing task terminals keeps the map and clears a removed maximize', () => {
  const s = useStore.getState()
  s.setActiveTask('one')
  const sid = sessionId('web', 'dev', 'one', 'p')
  s.addTaskComponentTerminal('web', 'dev')
  s.addTaskComponentTerminal('web', 'dev')
  expect(useStore.getState().componentTerminals).toHaveLength(1)
  expect(useStore.getState().activeSession).toBe(sid)
  s.setMaximizedTerminal(sid)
  s.removeTaskTerminal('web', 'dev')
  expect(useStore.getState().componentTerminals).toEqual([])
  expect(useStore.getState().maximizedTerminal).toBeNull()
  expect(useStore.getState().nodes[0].data.terminals).toHaveLength(1)
  const root = s.addRootTerminal(null)
  s.removeTaskTerminal(TASK_ROOT_SCOPE, root)
  expect(useStore.getState().rootTerminals.map((t) => t.id)).toEqual(['shell'])
  expect(useStore.getState().dirty).toBe(false)
})
test('a removed task no longer keeps its saved workspace', () => {
  const s = useStore.getState()
  s.setActiveTask('one')
  s.setActiveTask('two')
  s.setActiveTask(null)
  expect(Object.keys(useStore.getState().taskWorkspaces).sort()).toEqual(['', 'one', 'two'])
  s.setTasks([task('two', [])])
  expect(Object.keys(useStore.getState().taskWorkspaces).sort()).toEqual(['', 'two'])
})

test('Attention reveals a session predating the current task in its original workspace', async () => {
  const { revealTerminal } = await import('./attention')
  const sid = sessionId('web', 'dev', null)
  useStore.getState().setSession(sid, { running: true })
  useStore.getState().setTasks([{ ...task('current'), current: true }])
  expect(useStore.getState().activeTask).toBe('current')
  revealTerminal({ sid, componentId: 'web' })
  const s = useStore.getState()
  expect(s.activeTask).toBeNull()
  expect(s.view).toBe('implementation')
  expect(
    taskTerminals(s, s.nodes, s.runtimeTerminals, 'p', s.activeTask, s.sessions).map((t) => t.sid),
  ).toContain(sid)
  s.setTasks([{ ...task('current'), current: true }])
  expect(useStore.getState().activeTask).toBeNull()
})

test('hidden merges survive Review remounts, reveal again with the same active session, and never stay in the dock', async () => {
  const { MERGE_SCOPE, PLAN_SCOPE } = await import('../types')
  const { revealTerminal } = await import('./attention')
  const sid = sessionId(MERGE_SCOPE, 'destination', null, 'p')
  const s = useStore.getState()
  revealTerminal({ sid, componentId: MERGE_SCOPE })
  expect(useStore.getState().reviewAgents.p).toEqual({ sid, hidden: false })
  s.hideReviewAgent(sid)
  s.setView('navigation')
  s.setView('review')
  expect(useStore.getState().reviewAgents.p).toEqual({ sid, hidden: true })
  expect(useStore.getState().activeSession).toBe(sid)
  revealTerminal({ sid, componentId: MERGE_SCOPE })
  expect(useStore.getState().reviewAgents.p).toEqual({ sid, hidden: false })
  s.keepInDock(sid)
  expect(useStore.getState().dockKept).not.toContain(sid)
  const planner = sessionId(PLAN_SCOPE, 'planner', null, 'p')
  s.setActiveSession(planner)
  s.keepInDock(planner)
  expect(useStore.getState().dockKept).not.toContain(planner)
  s.setActiveSession(sessionId('web', 'dev', null, 'p'))
  expect(useStore.getState().dockKept).toContain(sessionId('web', 'dev', null, 'p'))
})

test('hidden reviews reveal again and never enter the dock', async () => {
  const { REVIEW_SCOPE } = await import('../types')
  const { revealTerminal } = await import('./attention')
  const sid = sessionId(REVIEW_SCOPE, 'review', null, 'p')
  const s = useStore.getState()
  revealTerminal({ sid, componentId: REVIEW_SCOPE })
  expect(useStore.getState().reviewAgents.p).toEqual({ sid, hidden: false })
  s.hideReviewAgent(sid)
  s.setView('navigation')
  s.setView('review')
  expect(useStore.getState().reviewAgents.p).toEqual({ sid, hidden: true })
  revealTerminal({ sid, componentId: REVIEW_SCOPE })
  expect(useStore.getState().reviewAgents.p).toEqual({ sid, hidden: false })
  s.keepInDock(sid)
  expect(useStore.getState().dockKept).not.toContain(sid)
})
