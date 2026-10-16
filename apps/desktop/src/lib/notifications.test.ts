import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mergeNotificationToast } from './notificationToast'
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
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getAllWebviewWindows: mock.focused }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.send }))
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: mock.granted,
  requestPermission: mock.request,
}))
const {
  agentEvent,
  followNotifications,
  restoredNotifications,
  sessionKind,
  describe,
  sendTestNotification,
  revealNotification,
} = await import('./notifications')
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
  mock.focused.mockResolvedValue([{ label: 'main', isFocused: async () => false }])
  mock.granted.mockResolvedValue(true)
  mock.request.mockResolvedValue('denied')
  mock.toast.mockImplementation((toast) => {
    mock.state.notificationToast = mergeNotificationToast(mock.state.notificationToast, toast)
  })
  mock.state = {
    sessions: { one: working, two: working, three: working },
    sessionRecords: [record('one'), record('two', { componentId: REVIEW_SCOPE }), record('three')],
    notifications: { ...DEFAULT_NOTIFICATIONS },
    runtimeTerminals: {},
    projects: {},
    nodes: [],
    devices: [],
    tasks: [],
    activeSession: null,
    notificationToast: null,
    project: null,
    setMessage: mock.message,
    setNotificationToast: mock.toast,
    activateProject: mock.activate,
    setActiveSession: mock.reveal,
    setView: vi.fn(),
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
test('focused pop-outs receive native delivery and sessions seen during debounce are dropped', async () => {
  mock.focused.mockResolvedValue([
    { label: 'main', isFocused: async () => false },
    { label: 'component-billing', isFocused: async () => true },
  ])
  stop = followNotifications()
  transition()
  transition('two', report('needsInput'))
  transition('one', { ...report('review'), status: { ...report('review').status!, seenMs: 1100 } })
  await vi.advanceTimersByTimeAsync(750)
  expect(mock.send).toHaveBeenCalledOnce()
  expect(mock.granted).toHaveBeenCalledOnce()
  expect(mock.toast).toHaveBeenCalledWith({
    message: expect.stringContaining('Needs input — Review agent'),
    sessions: [expect.objectContaining({ sid: 'two', label: 'Review agent' })],
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
      body: 'Project folder · Patchbay · Claude',
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
  mock.focused.mockRejectedValueOnce(new Error('window closed'))
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
test('restore validates boolean fields and defaults garbage', () => {
  for (const value of [null, undefined, [], 1, true, 'bad'])
    expect(restoredNotifications(value)).toEqual(DEFAULT_NOTIFICATIONS)
  expect(
    restoredNotifications({ enabled: false, finished: 'no', needsInput: false, failed: 0 }),
  ).toEqual({ ...DEFAULT_NOTIFICATIONS, enabled: false, needsInput: false })
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
  mock.focused.mockResolvedValue([{ label: 'main', isFocused: async () => true }])
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
    sessions: [expect.objectContaining({ sid: 'one', label: 'billing' })],
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
  expect(await sendTestNotification()).toBe(false)
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
  mock.focused.mockResolvedValue([{ label: 'main', isFocused: async () => true }])
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
