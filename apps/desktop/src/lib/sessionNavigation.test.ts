import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import {
  MAP_SCOPE,
  MERGE_SCOPE,
  PLAN_SCOPE,
  PROJECT_DRAFT,
  REVIEW_SCOPE,
  TASK_ROOT_SCOPE,
  sessionId,
  type Project,
  type SessionRecord,
  type Task,
} from '../types'
import { dockTabs } from './panels'
import { usePlanningSelection } from './planningScope'
import { simpleKey, useSimpleUi } from './simpleUi'
import { refreshSession } from './sessions'
import { reconnectSession, sessionDestinationAvailable } from './sessionNavigation'
import { taskTerminals } from './taskTerminals'

vi.mock('./ipc', () => ({ quitPatchbay: vi.fn(), workspaceLoad: vi.fn(), workspaceSave: vi.fn() }))
vi.mock('./windows', () => ({ openComponentWindow: vi.fn() }))
vi.mock('./sessions', () => ({ refreshSession: vi.fn(), reconcileSessions: vi.fn() }))

const terminal = { id: 'dev', name: 'Dev', command: 'cat', kind: 'task' as const }
const project = (id = 'p'): Project => ({
  projectId: id,
  name: id,
  root: `/${id}`,
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
      terminals: [terminal],
    },
  ],
})
const task = (id: string, missing = false): Task => ({
  id,
  title: id,
  worktree: `/p-${id}`,
  branch: id,
  components: ['web'],
  notes: '',
  createdMs: 1,
  missing,
  current: false,
})
function record(
  componentId = 'web',
  terminalId = 'dev',
  task: string | null = null,
  projectId = 'p',
): SessionRecord {
  const id = sessionId(componentId, terminalId, task, projectId)
  const r: SessionRecord = {
    id,
    metadata: {
      projectId,
      projectRoot: `/${projectId}`,
      projectName: projectId,
      componentId,
      terminalId,
      task,
      name: terminalId,
      kind: 'task',
      adapter: null,
      conversationId: null,
    },
    snapshot: {
      data: '',
      end: 0,
      truncated: false,
      running: true,
      generation: 7,
      startedMs: 1,
      exitedMs: null,
      exitCode: null,
      status: {
        lastOutputMs: null,
        active: false,
        agent: null,
        url: null,
        ready: false,
        healthy: null,
        stopped: false,
        seenMs: null,
      },
      notice: null,
    },
    spec: { cwd: task ? `/p-${task}` : `/${projectId}`, command: 'cat' },
    history: [],
    interrupted: false,
  }
  const s = useStore.getState()
  useStore.setState({ sessionRecords: [...s.sessionRecords, r] })
  s.setSession(id, { running: true, generation: 7 })
  return r
}

beforeEach(() => {
  vi.resetAllMocks()
  useStore.setState(useStore.getInitialState())
  useSimpleUi.setState({ worktrees: {} })
  usePlanningSelection.setState({ draftKey: null })
  useStore.getState().loadProject(project())
  useStore.getState().setTasks([task('one'), task('two')])
  useStore.setState({ utilityPanel: 'sessions' })
  vi.mocked(refreshSession).mockImplementation(async (sid) => {
    return useStore.getState().sessionRecords.find((r) => r.id === sid)?.snapshot ?? null
  })
})

test('reconnect reveals the exact component session without changing its run', async () => {
  const r = record()
  useStore.getState().setMaximizedTerminal('other')
  expect(await reconnectSession(r)).toBe('revealed')
  const s = useStore.getState()
  expect(s).toMatchObject({
    activeTask: null,
    selectedId: 'web',
    activeSession: r.id,
    view: 'implementation',
    maximizedTerminal: null,
    revealed: { sid: r.id, componentId: 'web' },
  })
  expect(
    taskTerminals(s, s.nodes, s.runtimeTerminals, 'p', null, s.sessions).map((t) => t.sid),
  ).toContain(r.id)
  expect(s.sessions[r.id]).toEqual({ running: true, generation: 7 })
  expect(refreshSession).toHaveBeenCalledExactlyOnceWith(r.id)
})

test('reconnect activates the saved project and worktree before revealing', async () => {
  const r = record('web', 'dev', 'one')
  useStore.getState().setActiveTask('two')
  useStore.getState().loadProject(project('q'))
  expect(await reconnectSession(r)).toBe('revealed')
  expect(useStore.getState()).toMatchObject({
    project: { id: 'p' },
    activeTask: 'one',
    activeSession: r.id,
    view: 'implementation',
  })
})

test('reconnect can return to main even when the checkout is assigned to a task', async () => {
  const r = record()
  useStore.getState().setTasks([{ ...task('current'), current: true }])
  expect(useStore.getState().activeTask).toBe('current')
  expect(await reconnectSession(r)).toBe('revealed')
  expect(useStore.getState().activeTask).toBeNull()
})

test('root shell reconnect selects its worktree terminal', async () => {
  const r = record(TASK_ROOT_SCOPE, 'shell', 'one')
  expect(await reconnectSession(r)).toBe('revealed')
  const s = useStore.getState()
  expect(s).toMatchObject({ activeTask: 'one', activeSession: r.id, view: 'implementation' })
  expect(
    taskTerminals(s, s.nodes, s.runtimeTerminals, 'p', 'one', s.sessions).map((t) => t.sid),
  ).toContain(r.id)
})

test.each([REVIEW_SCOPE, MERGE_SCOPE])('%s reveals its job in Review', async (scope) => {
  const r = record(scope, 'job')
  useStore.getState().setActiveTask('two')
  expect(await reconnectSession(r)).toBe('revealed')
  expect(useStore.getState()).toMatchObject({
    activeTask: 'two',
    activeSession: r.id,
    view: 'review',
    reviewAgents: { p: { sid: r.id, hidden: false } },
  })
})

test.each([null, 'one', PROJECT_DRAFT])(
  'planner reconnect selects its exact scope (%s)',
  async (task) => {
    const r = record(PLAN_SCOPE, 'claude', task)
    // An earlier draft selection must not hide a worktree planner in the same worktree.
    usePlanningSelection.getState().selectDraft(true)
    expect(await reconnectSession(r)).toBe('revealed')
    const s = useStore.getState()
    expect(s.activeSession).toBe(r.id)
    expect(s.view).toBe('plan')
    if (task === PROJECT_DRAFT) {
      expect(s.taskWorkspaces[PROJECT_DRAFT].planActive).toBe('claude')
      expect(usePlanningSelection.getState().draftKey).not.toBeNull()
    } else {
      expect(s.activeTask).toBe(task)
      expect(s.planActive).toBe('claude')
      expect(usePlanningSelection.getState().draftKey).toBeNull()
    }
  },
)

test('Chat reconnect uses the existing reveal path and keeps an unlisted planner pinned', async () => {
  const r = record(PLAN_SCOPE, 'removed-preset', 'one')
  r.metadata.kind = 'agent'
  useStore.getState().setSimpleMode(true)
  expect(await reconnectSession(r)).toBe('revealed')
  expect(useStore.getState()).toMatchObject({
    simpleMode: true,
    activeTask: 'one',
    activeSession: r.id,
  })
  expect(useSimpleUi.getState().worktrees[simpleKey('p', 'one')]).toMatchObject({
    terminal: 'user',
    terminalSession: { id: r.id, generation: 7, pinned: true },
  })
})

test.each([MAP_SCOPE, 'web'])('%s runtime reconnect selects its Navigation tab', async (scope) => {
  const r = record(scope, 'runtime')
  useStore.getState().addRuntimeTerminal(r.id, {
    projectId: 'p',
    componentId: scope,
    terminal: { ...terminal, id: 'runtime' },
    ...(scope === 'web' ? { extensionId: 'test' } : {}),
  })
  expect(await reconnectSession(r)).toBe('revealed')
  const s = useStore.getState()
  expect(s).toMatchObject({ activeSession: r.id, view: 'navigation' })
  expect(dockTabs(s).map((t) => t.sid)).toContain(r.id)
})

test('a retained terminal still has an Implementation destination without its map preset', async () => {
  const r = record('removed-component', 'retained', 'one')
  useStore.getState().addRuntimeTerminal(r.id, {
    projectId: 'p',
    taskId: 'one',
    componentId: 'removed-component',
    terminal: { ...terminal, id: 'retained' },
  })
  expect(await reconnectSession(r)).toBe('revealed')
  const s = useStore.getState()
  expect(
    taskTerminals(s, s.nodes, s.runtimeTerminals, 'p', 'one', s.sessions).map((t) => t.sid),
  ).toContain(r.id)
})

test.each([
  'closed-project',
  'missing-task',
  'removed-task',
  'removed-component',
  'removed-terminal',
  'removed-planner',
])('%s falls back without changing project or workspace selection', async (missing) => {
  const r =
    missing === 'removed-planner' ? record(PLAN_SCOPE, 'missing') : record('web', 'dev', 'one')
  const s = useStore.getState()
  if (missing === 'missing-task') s.setTasks([task('one', true)])
  if (missing === 'removed-task') s.setTasks([])
  if (missing === 'removed-component') useStore.setState({ nodes: [] })
  if (missing === 'removed-terminal') s.updateComponent('web', { terminals: [] })
  s.loadProject(project('q'))
  if (missing === 'closed-project') s.closeProject('p')
  const before = useStore.getState()
  expect(sessionDestinationAvailable(r)).toBe(false)
  expect(await reconnectSession(r)).toBe('unavailable')
  expect(useStore.getState()).toBe(before)
  expect(useStore.getState().utilityPanel).toBe('sessions')
})

test('an extension hidden by the selected worktree keeps its preview', async () => {
  const r = record('web', 'extension')
  useStore.getState().addRuntimeTerminal(r.id, {
    projectId: 'p',
    componentId: 'web',
    extensionId: 'ext',
    terminal: { ...terminal, id: 'extension' },
  })
  useStore.getState().setActiveTask('two')
  expect(await reconnectSession(r)).toBe('unavailable')
})

test.each(['snapshot', 'live-event', 'missing'])(
  'a session ending during reconnect stays in output preview (%s)',
  async (source) => {
    const r = record()
    vi.mocked(refreshSession).mockImplementationOnce(async () => {
      if (source === 'missing') return null
      const ended = { ...r.snapshot!, running: false, exitCode: 0 }
      useStore.getState().setSession(r.id, { running: false, generation: 7, exitCode: 0 })
      return source === 'snapshot' ? ended : r.snapshot
    })
    expect(await reconnectSession(r)).toBe('ended')
    expect(useStore.getState()).toMatchObject({
      activeSession: null,
      utilityPanel: 'sessions',
    })
  },
)

test('hydration failures propagate to the panel message handler without navigating', async () => {
  const r = record()
  vi.mocked(refreshSession).mockRejectedValueOnce(new Error('Disconnected'))
  const before = useStore.getState()
  await expect(reconnectSession(r)).rejects.toThrow('Disconnected')
  expect(useStore.getState()).toBe(before)
})

test('availability is checked after hydration if a project closes during the request', async () => {
  const r = record()
  vi.mocked(refreshSession).mockImplementationOnce(async () => {
    useStore.getState().closeProject('p')
    return r.snapshot
  })
  expect(await reconnectSession(r)).toBe('unavailable')
  expect(useStore.getState().project).toBeNull()
})

test('navigation failures propagate without closing the sessions rail', async () => {
  const r = record()
  useStore.setState({
    setActiveSession: () => {
      throw new Error('Navigation failed')
    },
  })
  await expect(reconnectSession(r)).rejects.toThrow('Navigation failed')
  expect(useStore.getState().utilityPanel).toBe('sessions')
})
