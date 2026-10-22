import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AutoRun, Task } from '../types'
import type { TaskWorkspace } from '../store'
import { mergeNotificationToast, removeNotificationSession } from './notificationToast'
import {
  DEFAULT_NOTIFICATIONS,
  PLAN_SCOPE,
  TASK_ROOT_SCOPE,
  REVIEW_SCOPE,
  MERGE_SCOPE,
  sessionId,
  sessionMetadata,
  type SessionState,
  type SessionStatus,
  type SessionRecord,
} from '../types'
type Snapshot = ReturnType<typeof import('../store').useStore.getState>
const mock = vi.hoisted(() => ({
  state: {} as Snapshot,
  listeners: new Set<(s: Snapshot, prev: Snapshot) => void>(),
  focused: vi.fn(),
  granted: vi.fn(),
  request: vi.fn(),
  send: vi.fn(),
  message: vi.fn(),
  toast: vi.fn(),
  dismiss: vi.fn(),
  activate: vi.fn(),
  reveal: vi.fn(),
}))
vi.mock('../store', () => ({
  projectStateOf: (id: string, s = mock.state) =>
    s.project?.id === id ? s : s.projects[id]?.state,
  useStore: {
    getState: () => mock.state,
    subscribe: (fn: (s: Snapshot, prev: Snapshot) => void) => {
      mock.listeners.add(fn)
      return () => mock.listeners.delete(fn)
    },
  },
}))
vi.stubGlobal('document', { hasFocus: () => mock.focused() })
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.send }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'main' }),
}))
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: mock.granted,
  requestPermission: mock.request,
}))
const {
  agentEvent,
  followNotifications,
  forgetNotificationPermission,
  sessionIdentity,
  describe,
  isCurrent,
  sendTestNotification,
  revealNotification,
} = await import('./notifications')
const sessionKind = (s: Snapshot, sid: string) => sessionIdentity(s, sid).kind
const working: SessionState = { running: true }
function report(state: 'review' | 'needsInput' | 'working', sinceMs = 1100): SessionState {
  return {
    running: true,
    status: {
      agent: { state, sinceMs, prompt: 'Fix the login redirect', message: null },
      seenMs: null,
      stopped: false,
    } as SessionStatus,
  }
}
function record(id: string, extra: Partial<SessionRecord['metadata']> = {}): SessionRecord {
  return {
    id,
    spec: { cwd: '/other', command: 'agent' },
    metadata: {
      projectId: 'other',
      projectRoot: '/other',
      projectName: 'Patchbay',
      componentId: 'billing',
      terminalId: 'agent',
      task: 'task',
      taskTitle: 'auth-refactor',
      kind: 'agent',
      name: 'Claude',
      adapter: 'claude',
      conversationId: null,
      ...extra,
    },
  } as SessionRecord
}
function update(patch: Partial<Snapshot>) {
  const prev = mock.state
  mock.state = { ...prev, ...patch }
  for (const fn of mock.listeners) fn(mock.state, prev)
}
function transition(sid = 'one', session = report('review')) {
  update({ sessions: { ...mock.state.sessions, [sid]: session } })
}
let stop: (() => void) | undefined
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  vi.resetAllMocks()
  forgetNotificationPermission()
  mock.focused.mockReturnValue(false)
  mock.granted.mockResolvedValue(true)
  mock.request.mockResolvedValue('denied')
  mock.toast.mockImplementation((toast) => {
    mock.state.notificationToast = mergeNotificationToast(mock.state.notificationToast, toast)
  })
  mock.dismiss.mockImplementation((sid) => {
    mock.state.notificationToast = removeNotificationSession(mock.state.notificationToast, sid)
  })
  mock.state = {
    sessions: { one: working, two: working, three: working },
    sessionRecords: [record('one'), record('two', { componentId: REVIEW_SCOPE }), record('three')],
    notifications: { ...DEFAULT_NOTIFICATIONS },
    runtimeTerminals: {},
    projects: {
      other: { state: { project: { id: 'other', name: 'Patchbay' }, nodes: [], tasks: [] } },
    },
    nodes: [],
    devices: [],
    tasks: [],
    activeSession: null,
    notificationToast: null,
    project: null,
    setMessage: mock.message,
    setNotificationToast: mock.toast,
    dismissNotificationSession: mock.dismiss,
    activateProject: mock.activate,
    setActiveSession: mock.reveal,
    setView: vi.fn(),
    setActiveTask: vi.fn(),
    showAutoPanel: vi.fn(),
  } as unknown as Snapshot
})
afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
})
test('reports new attention states and failed exits', () => {
  expect(agentEvent(working, report('review'))).toEqual({ kind: 'finished', atMs: 1100 })
  expect(agentEvent(working, report('needsInput'))).toEqual({ kind: 'needsInput', atMs: 1100 })
  expect(agentEvent(report('review', 1050), report('review'))).toEqual({
    kind: 'finished',
    atMs: 1100,
  })
  expect(agentEvent(report('needsInput', 1050), report('needsInput'))).toEqual({
    kind: 'needsInput',
    atMs: 1100,
  })
  expect(agentEvent(working, { running: false, exitCode: 0, exitedMs: 1200 })).toBeNull()
  expect(agentEvent(report('review'), { running: false, exitCode: 0, exitedMs: 1200 })).toBeNull()
  expect(agentEvent(working, { running: false, exitCode: 2, exitedMs: 1200 })).toEqual({
    kind: 'failed',
    atMs: 1200,
  })
  expect(agentEvent(working, { running: false, exitedMs: 1200 })?.kind).toBe('failed')
})
test('ignores hydration, unchanged reports, stopped exits, disconnects and interruptions', () => {
  expect(agentEvent(undefined, report('review'))).toBeNull()
  expect(agentEvent(report('review'), report('review'))).toBeNull()
  expect(agentEvent(report('needsInput'), report('needsInput'))).toBeNull()
  expect(agentEvent(working, report('working'))).toBeNull()
  for (const exitCode of [0, 1])
    expect(
      agentEvent(working, { running: false, exitCode, status: { stopped: true } as SessionStatus }),
    ).toBeNull()
  expect(agentEvent(working, { ...report('review'), disconnected: true })).toBeNull()
  expect(agentEvent(working, { ...report('review'), interrupted: true })).toBeNull()
})
test('batches projects and worktrees into one native summary', async () => {
  stop = followNotifications()
  transition()
  transition('two')
  transition('three')
  await vi.advanceTimersByTimeAsync(749)
  expect(mock.send).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(mock.send).toHaveBeenCalledOnce()
  expect(mock.send).toHaveBeenCalledWith('plugin:notification|notify', {
    options: {
      title: '3 agents finished',
      body: expect.stringContaining('Review agent: auth-refactor · Patchbay · Claude'),
    },
  })
  expect(mock.message).not.toHaveBeenCalled()
})
test('an unfocused main window gets native delivery and sessions seen during debounce are dropped', async () => {
  stop = followNotifications()
  transition()
  transition('two', report('needsInput'))
  transition('one', { ...report('review'), status: { ...report('review').status!, seenMs: 1100 } })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).toHaveBeenCalledOnce()
  expect(mock.granted).toHaveBeenCalledOnce()
  expect(mock.toast).toHaveBeenCalledWith({
    message: expect.stringContaining('Needs input — Review agent'),
    sessions: [
      expect.objectContaining({ sid: 'two', label: 'Review agent · Claude · auth-refactor' }),
    ],
  })
  expect(mock.toast.mock.calls[0][0].message).not.toContain('see Attention')
  expect(mock.toast.mock.calls[0][0].message).not.toContain('billing')
})
test('first hydration, start/seen boundaries and replayed timestamps stay silent', async () => {
  stop = followNotifications()
  transition('new')
  transition('one', report('review', 1000))
  transition('two', { ...report('review'), status: { ...report('review').status!, seenMs: 1100 } })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).not.toHaveBeenCalled()
  transition('one', working)
  transition('one', report('review', 2000))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).toHaveBeenCalledOnce()
  transition('one', working)
  transition('one', report('review', 2000))
  update({ sessions: {} })
  transition('one', report('review', 2000))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).toHaveBeenCalledOnce()
})
test('non-agent kinds are ignored', async () => {
  mock.state.sessionRecords[0] = record('one', { kind: 'shell' })
  mock.state.sessionRecords[1] = record('two', { kind: 'task' })
  stop = followNotifications()
  transition()
  transition('two')
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).not.toHaveBeenCalled()
})
test('kind lookup follows records, runtimes, other-project nodes and planner presets', () => {
  const sid = sessionId('billing', 'agent', null, 'other')
  mock.state.runtimeTerminals = {
    [sid]: { terminal: { kind: 'agent' } },
  } as Snapshot['runtimeTerminals']
  expect(sessionKind(mock.state, sid)).toBe('agent')
  mock.state.sessionRecords = [record(sid, { kind: 'task' })]
  expect(sessionKind(mock.state, sid)).toBe('task')
  mock.state.sessionRecords = []
  mock.state.runtimeTerminals = {}
  mock.state.projects = {
    other: {
      state: { nodes: [{ id: 'billing', data: { terminals: [{ id: 'agent', kind: 'agent' }] } }] },
    },
  } as unknown as Snapshot['projects']
  expect(sessionKind(mock.state, sid)).toBe('agent')
  expect(sessionKind(mock.state, sessionId(PLAN_SCOPE, 'claude', null, 'other'))).toBe('agent')
  expect(sessionKind(mock.state, 'unknown')).toBeUndefined()
})
test('descriptions label special scopes and project folders without an active project', () => {
  for (const [componentId, owner] of [
    [PLAN_SCOPE, 'Planner'],
    [TASK_ROOT_SCOPE, 'Task root'],
    [REVIEW_SCOPE, 'Review agent'],
    [MERGE_SCOPE, 'Merge agent'],
  ]) {
    mock.state.sessionRecords = [record('one', { componentId, task: null, taskTitle: null })]
    expect(describe(mock.state, 'one')).toEqual({
      owner,
      label: `${owner} · Claude · Project folder`,
      body: 'Project folder · Patchbay · Claude',
      toastBody: 'Project folder · Claude',
    })
  }
})
for (const field of ['enabled', 'finished', 'needsInput', 'failed'] as const)
  test(`disabled ${field} suppresses events`, async () => {
    mock.state.notifications[field] = false
    stop = followNotifications()
    transition(
      'one',
      field === 'needsInput'
        ? report('needsInput')
        : field === 'failed'
          ? { running: false, exitCode: 1, exitedMs: 1100 }
          : report('review'),
    )
    await vi.advanceTimersByTimeAsync(750)
    expect(mock.send).not.toHaveBeenCalled()
    expect(mock.message).not.toHaveBeenCalled()
  })
test('changed settings and disposal cancel pending delivery', async () => {
  stop = followNotifications()
  transition()
  update({ notifications: { ...DEFAULT_NOTIFICATIONS, enabled: false } })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).not.toHaveBeenCalled()
  update({ notifications: { ...DEFAULT_NOTIFICATIONS } })
  transition('two')
  stop()
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).not.toHaveBeenCalled()
})
test('mixed summaries and failed native/focus calls fall back to toast', async () => {
  stop = followNotifications()
  transition()
  transition('two', report('needsInput'))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).toHaveBeenCalledWith('plugin:notification|notify', {
    options: expect.objectContaining({ title: '2 agent updates' }),
  })
  mock.send.mockRejectedValueOnce(new Error('native failed'))
  transition('one', working)
  transition('one', report('review', 2500))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledTimes(2)
  mock.focused.mockImplementationOnce(() => {
    throw new Error('window closed')
  })
  transition('one', working)
  transition('one', report('review', 3500))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledTimes(3)
})
test('permission denial prompts once across events and the test button', async () => {
  mock.granted.mockResolvedValue(false)
  stop = followNotifications()
  transition()
  await vi.advanceTimersByTimeAsync(750)
  transition('one', working)
  transition('one', report('review', 2500))
  await vi.advanceTimersByTimeAsync(750)
  await sendTestNotification()
  expect(mock.request).toHaveBeenCalledOnce()
  expect(mock.send).not.toHaveBeenCalled()
  expect(mock.toast).toHaveBeenCalledTimes(3)
})
test('review and merge records without task metadata resolve their worktree title', () => {
  for (const componentId of [REVIEW_SCOPE, MERGE_SCOPE]) {
    mock.state.sessionRecords = [
      {
        ...record('one', { componentId, task: null, taskTitle: null }),
        spec: { cwd: '/other/feature', command: 'agent' },
      },
    ]
    mock.state.projects = {
      other: {
        state: {
          nodes: [],
          tasks: [{ id: 'feature', title: 'Review this worktree', worktree: '/other/feature' }],
        },
      },
    } as unknown as Snapshot['projects']
    expect(describe(mock.state, 'one').body).toBe('Review this worktree · Patchbay · Claude')
  }
})

test('acknowledgement during permission checks cancels native delivery too', async () => {
  let grant!: (value: boolean) => void
  mock.granted.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      grant = resolve
    }),
  )
  stop = followNotifications()
  transition()
  await vi.advanceTimersByTimeAsync(750)
  transition('one', { ...report('review'), status: { ...report('review').status!, seenMs: 1100 } })
  grant(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(mock.send).not.toHaveBeenCalled()
  expect(mock.toast).not.toHaveBeenCalled()
})

test('visible input requests and failures are cancelled at flush', async () => {
  stop = followNotifications()
  transition('one', report('needsInput'))
  transition('two', { running: false, exitCode: 1, exitedMs: 1100 })
  for (const sid of ['one', 'two']) {
    const session = mock.state.sessions[sid]
    transition(sid, { ...session, status: { ...session.status!, seenMs: 1100 } })
  }
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).not.toHaveBeenCalled()
  expect(mock.toast).not.toHaveBeenCalled()
})

test('a stale activeSession does not suppress an unseen background alert', async () => {
  mock.focused.mockReturnValue(true)
  mock.state.activeSession = 'one'
  stop = followNotifications()
  transition()
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledOnce()
})

test('new timestamps in the same state notify even after the original review was seen', async () => {
  mock.state.sessions.one = {
    ...report('review', 900),
    status: { ...report('review', 900).status!, seenMs: 950 },
  }
  stop = followNotifications()
  transition('one', report('review', 1100))
  transition('two', report('needsInput', 1100))
  await vi.advanceTimersByTimeAsync(750)
  transition('two', report('needsInput', 2100))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).toHaveBeenCalledTimes(2)
  expect(mock.toast).toHaveBeenCalledTimes(2)
})

test('resolved or removed sessions do not deliver stale queued alerts', async () => {
  stop = followNotifications()
  transition()
  transition('two')
  transition('one', working)
  update({ sessions: { one: mock.state.sessions.one } })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).not.toHaveBeenCalled()
  expect(mock.toast).not.toHaveBeenCalled()
})

test('only the latest state per session is included in a batch', async () => {
  stop = followNotifications()
  transition()
  transition('one', report('needsInput', 1200))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledWith({
    message: expect.stringContaining('Needs input'),
    sessions: [expect.objectContaining({ sid: 'one', label: 'billing · Claude · auth-refactor' })],
  })
  expect(mock.toast.mock.calls[0][0].message).not.toContain('Agent finished')
})

test('native success retains an in-app copy in case the OS suppresses the alert', async () => {
  stop = followNotifications()
  transition()
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).toHaveBeenCalledOnce()
  expect(mock.toast).toHaveBeenCalledOnce()
  expect(mock.message).not.toHaveBeenCalled()
})

test('notification links switch projects before revealing the exact review session', () => {
  mock.state.projects = {
    other: { state: { project: { id: 'other' } } },
  } as unknown as Snapshot['projects']
  expect(revealNotification('two')).toBe(true)
  expect(mock.activate).toHaveBeenCalledWith('other')
  expect(mock.reveal).toHaveBeenCalledWith('two')
  expect(mock.activate.mock.invocationCallOrder[0]).toBeLessThan(
    mock.reveal.mock.invocationCallOrder[0],
  )
  mock.state.projects = {}
  expect(revealNotification('two')).toBe(false)
})

test('test notifications also handle asynchronous native failures', async () => {
  mock.send.mockRejectedValueOnce(new Error('native failed'))
  expect(await sendTestNotification()).toEqual({
    status: 'failed',
    error: 'Error: native failed',
    granted: true,
  })
  expect(mock.toast).toHaveBeenCalledWith({
    message: expect.stringContaining('unavailable'),
    sessions: [],
  })
})

test('an old pending turn is discarded when a new turn arrives during native checks', async () => {
  let grant!: (value: boolean) => void
  mock.granted.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      grant = resolve
    }),
  )
  stop = followNotifications()
  transition()
  await vi.advanceTimersByTimeAsync(750)
  transition('one', working)
  transition('one', report('review', 2000))
  grant(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(mock.send).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).toHaveBeenCalledOnce()
})

test('stopped and interrupted sessions cancel pending alerts', async () => {
  stop = followNotifications()
  transition('one', report('needsInput'))
  transition('two', { running: false, exitCode: 1, exitedMs: 1100 })
  transition('one', {
    ...report('needsInput'),
    status: { ...report('needsInput').status!, stopped: true },
  })
  transition('two', { ...mock.state.sessions.two, interrupted: true })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
  expect(mock.send).not.toHaveBeenCalled()
})

test('a focused main window uses the in-app alert', async () => {
  mock.focused.mockReturnValue(true)
  stop = followNotifications()
  transition()
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).not.toHaveBeenCalled()
  expect(mock.granted).not.toHaveBeenCalled()
  expect(mock.toast).toHaveBeenCalledOnce()
})

test('a new turn ending in review without an observed working tick notifies once', async () => {
  stop = followNotifications()
  transition()
  await vi.advanceTimersByTimeAsync(750)
  transition('one', report('review', 2000))
  await vi.advanceTimersByTimeAsync(750)
  transition('one', report('review', 2000))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).toHaveBeenCalledTimes(2)
})

test('different event kinds at the same timestamp notify, but replay is suppressed', async () => {
  stop = followNotifications()
  transition()
  await vi.advanceTimersByTimeAsync(750)
  transition('one', report('needsInput'))
  await vi.advanceTimersByTimeAsync(750)
  transition('one', report('review'))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).toHaveBeenCalledTimes(2)
})

for (const scope of [TASK_ROOT_SCOPE, REVIEW_SCOPE, MERGE_SCOPE])
  for (const kind of ['needsInput', 'failed'] as const)
    test(`${scope} ${kind} alerts before records reconcile`, async () => {
      const sid = sessionId(scope, 'fast-agent', 'task', 'other')
      mock.state.projects = {
        other: {
          state: {
            project: { id: 'other', name: 'Other' },
            nodes: [],
            tasks: [],
            activeTask: null,
            taskWorkspaces: {
              task: {
                rootTerminals: [{ id: 'fast-agent', name: 'Fast', kind: 'agent' }],
              },
            },
          },
        },
      } as unknown as Snapshot['projects']
      stop = followNotifications()
      transition(sid, working)
      transition(
        sid,
        kind === 'needsInput'
          ? report('needsInput')
          : {
              running: false,
              exitCode: 1,
              exitedMs: 1100,
            },
      )
      await vi.advanceTimersByTimeAsync(750)
      expect(mock.send).toHaveBeenCalledOnce()
      expect(mock.state.notificationToast?.sessions[0].sid).toBe(sid)
    })

test('live events with no identity wait for records instead of being lost', async () => {
  stop = followNotifications()
  transition('unidentified', working)
  transition('unidentified', { running: false, exitCode: 1, exitedMs: 1100 })
  await vi.advanceTimersByTimeAsync(2000)
  expect(mock.toast).not.toHaveBeenCalled()
  // Reconciliation can update the snapshot before publishing its record list.
  transition('unidentified', { ...mock.state.sessions.unidentified })
  update({
    sessionRecords: [
      ...mock.state.sessionRecords,
      record('unidentified', { componentId: REVIEW_SCOPE }),
    ],
  })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).toHaveBeenCalledOnce()
  expect(mock.state.notificationToast?.message).toContain('Agent failed')
})

test('an unidentified session acknowledged before reconciliation stays silent', async () => {
  stop = followNotifications()
  transition('unidentified', working)
  transition('unidentified', report('needsInput'))
  transition('unidentified', {
    ...report('needsInput'),
    status: { ...report('needsInput').status!, seenMs: 1100 },
  })
  update({ sessionRecords: [...mock.state.sessionRecords, record('unidentified')] })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
})

test('later batches retain earlier unread input requests even after native success', async () => {
  stop = followNotifications()
  transition('one', report('needsInput'))
  await vi.advanceTimersByTimeAsync(750)
  transition('two', report('review', 2000))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).toHaveBeenCalledTimes(2)
  expect(mock.state.notificationToast?.sessions.map((s) => s.sid)).toEqual(['one', 'two'])
  expect(mock.state.notificationToast?.message).toContain('Needs input')
  expect(mock.state.notificationToast?.message).toContain('Agent finished')
})

test('task-root kind lookup respects the active workspace and other-project shell presets', () => {
  const sid = sessionId(TASK_ROOT_SCOPE, 'root', null, 'other')
  mock.state.projects = {
    other: {
      state: {
        nodes: [],
        activeTask: null,
        tasks: [],
        rootTerminals: [{ id: 'root', kind: 'shell' }],
      },
    },
  } as unknown as Snapshot['projects']
  expect(sessionKind(mock.state, sid)).toBe('shell')
})

test('branch scope metadata also supports reveal before record reconciliation', () => {
  const sid = sessionId(REVIEW_SCOPE, 'job', null, 'other')
  mock.state.projects = {
    other: { state: { project: { id: 'other' }, nodes: [], tasks: [] } },
  } as unknown as Snapshot['projects']
  expect(sessionMetadata.has(sid)).toBe(true)
  expect(revealNotification(sid)).toBe(true)
  expect(mock.activate).toHaveBeenCalledWith('other')
  expect(mock.reveal).toHaveBeenCalledWith(sid)
})

test('isCurrent follows seen, resolved, stopped and restarted sessions', () => {
  const event = { kind: 'finished', atMs: 1100 } as const
  mock.state.sessions.one = report('review')
  expect(isCurrent(mock.state, 'one', event)).toBe(true)
  expect(isCurrent(mock.state, 'one', { ...event, atMs: 1000 })).toBe(false)
  expect(isCurrent(mock.state, 'one', { kind: 'needsInput', atMs: 1100 })).toBe(false)
  mock.state.sessions.one = {
    ...report('review'),
    status: { ...report('review').status!, seenMs: 1100 },
  }
  expect(isCurrent(mock.state, 'one', event)).toBe(false)
  mock.state.sessions.one = {
    ...report('review'),
    status: { ...report('review').status!, stopped: true },
  }
  expect(isCurrent(mock.state, 'one', event)).toBe(false)
  mock.state.sessions.one = working
  expect(isCurrent(mock.state, 'one', event)).toBe(false)
  expect(isCurrent(mock.state, 'gone', event)).toBe(false)
})

test('in-app links drop out once seen or resolved elsewhere, and the alert then hides', async () => {
  stop = followNotifications()
  transition('one', report('needsInput'))
  transition('two', report('review'))
  transition('three', { running: false, exitCode: 1, exitedMs: 1100 })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.state.notificationToast?.sessions.map((s) => s.sid)).toEqual(['one', 'two', 'three'])
  // Answered in the terminal: no longer waiting for input.
  transition('one', working)
  expect(mock.state.notificationToast?.sessions.map((s) => s.sid)).toEqual(['two', 'three'])
  // Seen in some other window.
  transition('two', { ...report('review'), status: { ...report('review').status!, seenMs: 1200 } })
  expect(mock.state.notificationToast?.sessions.map((s) => s.sid)).toEqual(['three'])
  // Restarted.
  transition('three', working)
  expect(mock.state.notificationToast).toBeNull()
})

test('links without a tracked event stay until viewed or dismissed', () => {
  stop = followNotifications()
  update({ notificationToast: { message: 'Root', sessions: [{ sid: 'gone', label: 'Root' }] } })
  transition('one', working)
  expect(mock.state.notificationToast?.sessions).toHaveLength(1)
  expect(mock.dismiss).not.toHaveBeenCalled()
})

test('sessions of projects that are not open do not alert, and closing one drops its links', async () => {
  mock.state.sessionRecords.push(record('closed', { projectId: 'closed' }))
  mock.state.sessions.closed = working
  stop = followNotifications()
  transition('closed', report('review'))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
  expect(mock.send).not.toHaveBeenCalled()
  transition('one', report('review'))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.state.notificationToast?.sessions).toHaveLength(1)
  update({ projects: {} })
  expect(mock.state.notificationToast).toBeNull()
})

test('links of one owner name their terminal or lane, worktree and other projects', async () => {
  mock.state.sessionRecords = [
    record('one', { componentId: REVIEW_SCOPE, name: 'Claude' }),
    record('two', {
      componentId: REVIEW_SCOPE,
      name: undefined,
      lane: 'codex',
      task: null,
      taskTitle: null,
    }),
  ]
  stop = followNotifications()
  transition('one')
  transition('two')
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.state.notificationToast?.sessions).toEqual([
    expect.objectContaining({
      label: 'Review agent · Claude · auth-refactor',
      project: { id: 'other', name: 'Patchbay' },
    }),
    expect.objectContaining({ label: 'Review agent · codex · Project folder' }),
  ])
})

test('unidentified events are rechecked only when identity sources change', async () => {
  stop = followNotifications()
  transition('unidentified', working)
  transition('unidentified', report('needsInput'))
  // A record added in place is invisible to reference checks, so unrelated updates skip it.
  mock.state.sessionRecords.push(record('unidentified'))
  update({ activeSession: 'x' } as Partial<Snapshot>)
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
  update({ sessionRecords: [...mock.state.sessionRecords] })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledOnce()
})

test('an event of a closed project alerts once its tab opens, while still current', async () => {
  mock.state.sessionRecords.push(record('closed', { projectId: 'closed' }))
  mock.state.sessions.closed = working
  stop = followNotifications()
  transition('closed', report('review'))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
  const open = (name: string) => ({
    ...mock.state.projects,
    closed: { state: { project: { id: 'closed', name }, nodes: [], tasks: [] } },
  })
  update({ projects: open('Closed') as unknown as Snapshot['projects'] })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledOnce()
  expect(mock.state.notificationToast?.sessions[0].sid).toBe('closed')
  // Delivered once; later project changes don't repeat it.
  update({ projects: open('Renamed') as unknown as Snapshot['projects'] })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledOnce()
})

test('an event that stopped being current while its project was closed stays silent', async () => {
  mock.state.sessionRecords.push(record('closed', { projectId: 'closed' }))
  mock.state.sessions.closed = working
  stop = followNotifications()
  transition('closed', report('review'))
  transition('closed', working)
  update({
    projects: {
      ...mock.state.projects,
      closed: { state: { project: { id: 'closed', name: 'Closed' }, nodes: [], tasks: [] } },
    } as unknown as Snapshot['projects'],
  })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
})

test('overwriting known session metadata rechecks unidentified events', async () => {
  sessionMetadata.set('meta', {
    projectId: 'other',
    componentId: 'unknown',
    terminalId: 'agent',
    task: null,
  })
  stop = followNotifications()
  transition('meta', working)
  transition('meta', report('needsInput'))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
  // Same key, same map size: only the version reveals the change.
  sessionMetadata.set('meta', {
    projectId: 'other',
    componentId: REVIEW_SCOPE,
    terminalId: 'agent',
    task: null,
  })
  update({ activeSession: 'x' } as Partial<Snapshot>)
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledOnce()
  sessionMetadata.delete('meta')
})

test('unchanged metadata writes keep the version', () => {
  const value = { projectId: 'p', componentId: 'c', terminalId: 't', task: null }
  sessionMetadata.set('same', value)
  const version = sessionMetadata.version
  sessionMetadata.set('same', { ...value })
  expect(sessionMetadata.version).toBe(version)
  sessionMetadata.set('same', { ...value, task: 'x' })
  expect(sessionMetadata.version).toBe(version + 1)
  sessionMetadata.delete('same')
  expect(sessionMetadata.version).toBe(version + 2)
})

test('test notifications report denial apart from failures and still show their hint', async () => {
  mock.granted.mockResolvedValue(false)
  update({
    notificationToast: {
      message: 'one needs input',
      sessions: [{ sid: 'one', label: 'one', message: 'one needs input' }],
    },
  })
  expect(await sendTestNotification()).toEqual({ status: 'denied' })
  expect(mock.state.notificationToast?.notice).toContain('unavailable')
  expect(mock.state.notificationToast?.sessions).toHaveLength(1)
  mock.granted.mockRejectedValueOnce(new Error('no plugin'))
  expect(await sendTestNotification()).toEqual({
    status: 'failed',
    error: 'Error: no plugin',
    granted: false,
  })
  mock.granted.mockResolvedValue(true)
  expect(await sendTestNotification()).toEqual({ status: 'granted' })
})

test('a granted permission is cached until a send fails', async () => {
  stop = followNotifications()
  transition()
  await vi.advanceTimersByTimeAsync(750)
  transition('one', working)
  transition('one', report('review', 2000))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).toHaveBeenCalledTimes(2)
  expect(mock.granted).toHaveBeenCalledOnce()
  mock.send.mockRejectedValueOnce(new Error('not permitted'))
  transition('one', working)
  transition('one', report('review', 3000))
  await vi.advanceTimersByTimeAsync(750)
  transition('one', working)
  transition('one', report('review', 4000))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.granted).toHaveBeenCalledTimes(2)
  expect(mock.send).toHaveBeenCalledTimes(4)
})

test('links are pruned on session, project, record or toast changes, not unrelated ones', async () => {
  stop = followNotifications()
  transition('one', report('needsInput'))
  await vi.advanceTimersByTimeAsync(750)
  // Resolved in place, invisible to reference checks.
  mock.state.sessions.one = working
  update({ nodes: [] })
  update({ runtimeTerminals: {} })
  expect(mock.dismiss).not.toHaveBeenCalled()
  update({ sessionRecords: [...mock.state.sessionRecords] })
  expect(mock.dismiss).toHaveBeenCalledWith('one')
})

function autoRun(patch: Partial<AutoRun> = {}): AutoRun {
  return {
    runId: 'run',
    status: 'running',
    stage: 'review',
    goal: 'Ship',
    effort: 'standard',
    merge: { mode: 'ask', destinationBranch: 'main' },
    device: 'claude',
    round: 0,
    sessionId: 'one',
    laneSessions: [{ sessionId: 'three' }],
    log: [{ atMs: 1500, text: 'Reviewing' }],
    ...patch,
  }
}
function setAuto(run: AutoRun | null) {
  const other = mock.state.projects.other!
  update({
    projects: {
      ...mock.state.projects,
      other: { ...other, state: { ...other.state!, activeTask: null, auto: run } },
    },
  })
}

test('turn ends of sessions a running Auto run tracks stay silent; input and failures alert', async () => {
  setAuto(autoRun())
  stop = followNotifications()
  transition('one', report('review'))
  transition('three', report('review'))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
  transition('one', report('needsInput', 1200))
  transition('three', { running: false, exitCode: 1, exitedMs: 1200 })
  transition('two', report('review'))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.state.notificationToast?.sessions.map((s) => s.sid)).toEqual(['one', 'three', 'two'])
})

for (const status of ['paused', 'waitingOnYou'] as const)
  test(`a ${status} Auto run suppresses its sessions' turn ends`, async () => {
    setAuto(autoRun({ status }))
    stop = followNotifications()
    transition('one', report('review'))
    transition('three', report('review'))
    await vi.advanceTimersByTimeAsync(750)
    expect(mock.toast).not.toHaveBeenCalled()
    expect(mock.send).not.toHaveBeenCalled()
  })

test('manual turns during an Auto pause alert, while its original turn stays silent', async () => {
  setAuto(autoRun({ status: 'paused' }))
  stop = followNotifications()
  transition('one', report('review'))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
  transition('one', report('working', 2100))
  transition('one', report('review', 2200))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.state.notificationToast?.sessions.map((s) => s.sid)).toEqual(['one'])
  // Another lane still belongs to Auto, and resuming reclaims the manually driven session.
  transition('three', report('review', 2300))
  setAuto(autoRun())
  transition('one', report('working', 2400))
  transition('one', report('review', 2500))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledOnce()
})

test('a working report at follower startup does not prove a manual turn during a pause', async () => {
  setAuto(autoRun({ status: 'paused' }))
  mock.state.sessions.one = report('working', 2100)
  stop = followNotifications()
  transition('one', report('review', 2200))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
})

test.each(['one', 'three'])(
  'a delayed Auto working report for %s stays owned after pausing',
  async (sid) => {
    setAuto(autoRun())
    stop = followNotifications()
    setAuto(autoRun({ status: 'paused', log: [{ atMs: 1500, text: 'Paused by you' }] }))
    transition(sid, report('working', 2100))
    transition(sid, report('review', 2200))
    await vi.advanceTimersByTimeAsync(750)
    expect(mock.toast).not.toHaveBeenCalled()
    expect(mock.send).not.toHaveBeenCalled()
  },
)

test('a changed turn identity during a pause alerts even between working reports', async () => {
  const turn = (id: string, sinceMs: number) => {
    const session = report('working', sinceMs)
    return {
      ...session,
      status: { ...session.status!, agent: { ...session.status!.agent!, turnId: id } },
    }
  }
  setAuto(autoRun({ status: 'paused' }))
  mock.state.sessions.one = turn('original', 1400)
  stop = followNotifications()
  transition('one', turn('manual', 2100))
  transition('one', report('review', 2200))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledOnce()
})

test('a manual turn during a pause can alert when its working report was missed', async () => {
  setAuto(autoRun({ status: 'paused' }))
  mock.state.sessions.one = report('review', 900)
  stop = followNotifications()
  transition('one', report('review', 2200))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledOnce()
})

for (const status of ['done', 'stopped', 'failed'] as const)
  test(`a ${status} Auto run releases its sessions' turn ends`, async () => {
    setAuto(autoRun({ status }))
    stop = followNotifications()
    transition('one', report('review'))
    await vi.advanceTimersByTimeAsync(750)
    expect(mock.toast).toHaveBeenCalledOnce()
  })

test('a turn end batched with a merge-gate pause sends only the Auto alert', async () => {
  stop = followNotifications()
  // The turn end queues before Auto publishes its ownership and pause.
  transition('one', report('review'))
  setAuto(autoRun({ status: 'waitingOnYou', stage: 'mergeGate' }))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).toHaveBeenCalledOnce()
  expect(mock.send).toHaveBeenCalledWith('plugin:notification|notify', {
    options: {
      title: 'Auto mode asks to merge',
      body: 'Project folder · Patchbay',
    },
  })
  expect(mock.state.notificationToast?.sessions.map((s) => s.sid)).toEqual(['auto:other:'])
})

test('focused active worktrees silence Auto pauses; other worktrees and failures alert', async () => {
  setAuto(autoRun())
  mock.state = { ...mock.state, ...mock.state.projects.other!.state! } as Snapshot
  stop = followNotifications()
  update({ auto: autoRun({ status: 'waitingOnYou', stage: 'mergeGate' }) })
  // Visibility is checked at flush, even if the window was unfocused when queued.
  mock.focused.mockReturnValue(true)
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
  update({
    activeTask: 't1',
    auto: null,
    taskWorkspaces: {
      '': { auto: autoRun({ status: 'waitingOnYou', stage: 'mergeGate' }) } as TaskWorkspace,
    },
  })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
  update({
    activeTask: null,
    auto: autoRun(),
    tasks: [{ id: 't1', title: 'Another worktree' }] as Task[],
    taskWorkspaces: { t1: { auto: autoRun() } as TaskWorkspace },
  })
  update({
    taskWorkspaces: {
      t1: { auto: autoRun({ status: 'waitingOnYou', stage: 'mergeGate' }) } as TaskWorkspace,
    },
  })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledOnce()
  expect(mock.state.notificationToast?.sessions[0].auto?.task).toBe('t1')
  update({ auto: autoRun({ status: 'failed', reason: 'Merge conflict', stage: 'mergeGate' }) })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledTimes(2)
  expect(mock.state.notificationToast?.message).toContain('Auto mode failed')
  expect(mock.state.notificationToast?.message).toContain('Merge conflict')
})

test('a focused worktree in another project still alerts', async () => {
  setAuto(autoRun())
  mock.state.project = { id: 'active', name: 'Active' } as Snapshot['project']
  mock.state.activeTask = null
  mock.focused.mockReturnValue(true)
  stop = followNotifications()
  setAuto(autoRun({ status: 'waitingOnYou', stage: 'mergeGate' }))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledOnce()
})

test('Auto input requests alert in Review even while their worktree is active', async () => {
  setAuto(autoRun({ status: 'waitingOnYou', waitingFor: 'agentInput' }))
  mock.state = { ...mock.state, ...mock.state.projects.other!.state!, view: 'review' } as Snapshot
  mock.focused.mockReturnValue(true)
  stop = followNotifications()
  transition('one', report('needsInput'))
  transition('three', report('needsInput'))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.state.notificationToast?.sessions.map((s) => s.sid)).toEqual(['one', 'three'])
  expect(mock.send).not.toHaveBeenCalled()
  // Leaving the worktree keeps the unread request available without needing another agent event.
  update({ activeTask: 'another' })
  expect(mock.state.notificationToast?.sessions.map((s) => s.sid)).toEqual(['one', 'three'])
})

test('an Auto input request seen in its terminal before delivery stays silent', async () => {
  setAuto(autoRun({ status: 'waitingOnYou', waitingFor: 'agentInput' }))
  mock.state = { ...mock.state, ...mock.state.projects.other!.state! } as Snapshot
  mock.focused.mockReturnValue(true)
  stop = followNotifications()
  transition('one', report('needsInput'))
  const session = report('needsInput')
  transition('one', { ...session, status: { ...session.status!, seenMs: 1100 } })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
})

test('a focused worktree still alerts for another Auto worktree and untracked input', async () => {
  setAuto(autoRun({ status: 'paused' }))
  setTaskAuto(autoRun({ sessionId: 'two', laneSessions: [] }), [{ id: 't1', title: 'Other' }])
  mock.state = { ...mock.state, ...mock.state.projects.other!.state! } as Snapshot
  mock.state.sessions.untracked = working
  mock.state.sessionRecords.push(record('untracked'))
  mock.focused.mockReturnValue(true)
  stop = followNotifications()
  transition('one', report('needsInput'))
  transition('two', report('needsInput'))
  transition('untracked', report('needsInput'))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.state.notificationToast?.sessions.map((s) => s.sid)).toEqual([
    'one',
    'two',
    'untracked',
  ])
})

test('an Auto run alerts once per pause, links to its panel and drops out when resumed', async () => {
  setAuto(autoRun())
  stop = followNotifications()
  setAuto(autoRun({ status: 'waitingOnYou', stage: 'mergeGate', reason: 'Approve the merge' }))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledOnce()
  const link = mock.state.notificationToast!.sessions[0]
  expect(link).toMatchObject({
    sid: 'auto:other:',
    kind: 'needsInput',
    label: 'Auto mode · Project folder',
    auto: { projectId: 'other', task: null },
  })
  expect(link.message).toContain('Auto mode asks to merge')
  expect(link.message).not.toContain('Approve the merge')
  // The same pause, republished, doesn't alert again.
  setAuto(autoRun({ status: 'waitingOnYou', stage: 'mergeGate', reason: 'Approve the merge' }))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledOnce()
  expect(revealNotification(link.sid, link.auto)).toBe(true)
  expect(mock.activate).toHaveBeenCalledWith('other')
  expect(mock.state.showAutoPanel).toHaveBeenCalled()
  setAuto(autoRun({ stage: 'merge' }))
  expect(mock.state.notificationToast).toBeNull()
  setAuto(autoRun({ status: 'failed', stage: 'merge', reason: 'Merge conflict' }))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledTimes(2)
  expect(mock.state.notificationToast?.message).toContain('Auto mode failed')
})

test('Auto pauses respect preferences, skip input waits and restored states', async () => {
  setAuto(autoRun({ status: 'failed' }))
  stop = followNotifications()
  // Already failed when the follower started.
  setAuto(autoRun({ status: 'failed', reason: 'Still failed' }))
  // Its agent's own input request alerts instead.
  setAuto(autoRun({ status: 'waitingOnYou', waitingFor: 'agentInput' }))
  update({ notifications: { ...DEFAULT_NOTIFICATIONS, needsInput: false } })
  setAuto(autoRun({ status: 'waitingOnYou', stage: 'fix', waitingFor: 'fixBudget' }))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
})

function setTaskAuto(run: AutoRun, tasks: { id: string; title: string }[] = []) {
  const other = mock.state.projects.other!
  update({
    projects: {
      ...mock.state.projects,
      other: {
        ...other,
        state: {
          ...other.state!,
          activeTask: null,
          tasks: tasks as Task[],
          taskWorkspaces: { ...other.state!.taskWorkspaces, t1: { auto: run } as TaskWorkspace },
        },
      },
    },
  })
}

test('session and Auto titles are short; merge approval omits its redundant reason', async () => {
  const title = 'Fix trends nutrition graphs. When navigating between timeframes it is broken.'
  mock.state.sessionRecords[0] = record('one', { taskTitle: title })
  expect(describe(mock.state, 'one')).toMatchObject({
    label: 'billing · Claude · Fix trends nutrition graphs…',
    body: 'Fix trends nutrition graphs… · Patchbay · Claude',
    toastBody: 'Fix trends nutrition graphs… · Claude',
  })
  setTaskAuto(autoRun(), [{ id: 't1', title }])
  stop = followNotifications()
  setTaskAuto(
    autoRun({
      status: 'waitingOnYou',
      stage: 'mergeGate',
      reason: 'Ready to merge — approval required',
    }),
    [{ id: 't1', title }],
  )
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.state.notificationToast?.sessions[0]).toMatchObject({
    label: 'Auto mode · Fix trends nutrition graphs…',
    message: 'Auto mode asks to merge — Fix trends nutrition graphs…',
    project: { id: 'other', name: 'Patchbay' },
  })
  expect(mock.send).toHaveBeenCalledWith('plugin:notification|notify', {
    options: {
      title: 'Auto mode asks to merge',
      body: 'Fix trends nutrition graphs… · Patchbay',
    },
  })
  setTaskAuto(
    autoRun({ status: 'waitingOnYou', stage: 'fix', reason: 'Fix round limit reached' }),
    [{ id: 't1', title }],
  )
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.state.notificationToast?.message).toBe(
    'Auto mode is waiting on you — Fix trends nutrition graphs… — “Fix round limit reached”',
  )
})

test('Auto runs restored after their project appears stay silent', async () => {
  update({ restoring: true })
  stop = followNotifications()
  // The project's tab appears before its saved layout is applied.
  setAuto(null)
  setAuto(autoRun({ status: 'failed', reason: 'Failed last session' }))
  setTaskAuto(autoRun({ runId: 'task-run', status: 'failed' }))
  update({ restoring: false })
  // The task list loads after restore.
  setTaskAuto(autoRun({ runId: 'task-run', status: 'failed' }), [{ id: 't1', title: 'Feature' }])
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
  setAuto(autoRun({ runId: 'next', status: 'failed', reason: 'New failure' }))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledOnce()
})

test('a pause reached before its worktree is listed alerts once listed', async () => {
  setAuto(autoRun())
  stop = followNotifications()
  setTaskAuto(autoRun({ runId: 'task-run' }))
  setTaskAuto(autoRun({ runId: 'task-run', status: 'waitingOnYou', stage: 'mergeGate' }))
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).not.toHaveBeenCalled()
  setTaskAuto(autoRun({ runId: 'task-run', status: 'waitingOnYou', stage: 'mergeGate' }), [
    { id: 't1', title: 'Feature' },
  ])
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.toast).toHaveBeenCalledOnce()
  expect(mock.state.notificationToast?.message).toContain('Auto mode asks to merge')
})

test('a revoked grant is asked for again after a failed send', async () => {
  // A fresh module: earlier tests' refused prompt stays cached for the webview's lifetime.
  vi.resetModules()
  const { notificationPermission, forgetNotificationPermission } = await import('./notifications')
  mock.granted.mockResolvedValue(false)
  mock.request.mockResolvedValue('granted')
  expect(await notificationPermission()).toBe(true)
  forgetNotificationPermission()
  await Promise.resolve()
  mock.request.mockResolvedValue('denied')
  expect(await notificationPermission()).toBe(false)
  expect(mock.request).toHaveBeenCalledTimes(2)
  // A refused prompt isn't repeated.
  forgetNotificationPermission()
  await Promise.resolve()
  expect(await notificationPermission()).toBe(false)
  expect(mock.request).toHaveBeenCalledTimes(2)
})
