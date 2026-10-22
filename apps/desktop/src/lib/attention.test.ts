import { expect, test, vi } from 'vitest'
import type { SessionState, TerminalSpec } from '../types'
import { PLAN_SCOPE, sessionId, setProjectIdentity } from '../types'

const revealState = vi.hoisted(() => ({
  project: { id: 'p-1' },
  setActiveSession: vi.fn(),
  setView: vi.fn(),
  setActiveTask: vi.fn(),
  select: vi.fn(),
}))
vi.mock('../store', () => ({ useStore: { getState: () => revealState } }))
const { attentionCounts, attentionItems, componentTerminals, mostUrgent, worktreeAttention } =
  await import('./attention')

setProjectIdentity('p-1')

const terminal = (id: string, kind: TerminalSpec['kind'] = 'task'): TerminalSpec => ({
  id,
  name: id,
  command: id,
  kind,
})
const node = (id: string, terminals: TerminalSpec[]) => ({ id, data: { name: id, terminals } })
const failed = (exitedMs: number): SessionState => ({ running: false, exitCode: 1, exitedMs })
const needsInput = (sinceMs: number): SessionState => ({
  running: true,
  status: {
    lastOutputMs: null,
    active: false,
    agent: { state: 'needsInput', sinceMs, message: null, prompt: null },
    url: null,
    ready: false,
    healthy: null,
    stopped: false,
    seenMs: null,
  },
})

function snapshot(sessions: Record<string, SessionState>, extra = {}) {
  return {
    nodes: [node('web', [terminal('test'), terminal('lint'), terminal('agent', 'agent')])],
    sessions,
    runtimeTerminals: {},
    devices: [],
    tasks: [{ id: 'abc', title: 'Fix login' }],
    ...extra,
  } as unknown as Parameters<typeof attentionItems>[0]
}

test('needs input outranks failures; older first within a level', () => {
  const items = attentionItems(
    snapshot({
      [sessionId('web', 'test')]: failed(200),
      [sessionId('web', 'lint')]: failed(100),
      [sessionId('web', 'agent', 'abc')]: needsInput(300),
      [sessionId(PLAN_SCOPE, 'claude')]: needsInput(50),
    }),
    1_000,
  )
  expect(items.map((i) => [i.owner, i.terminal.id, i.task, i.status.label])).toEqual([
    ['Planner', 'claude', null, 'Needs input'],
    ['web', 'agent', 'abc', 'Needs input'],
    ['web', 'lint', null, 'Failed'],
    ['web', 'test', null, 'Failed'],
  ])
  expect(items[1].taskTitle).toBe('Fix login')
})

test('counts are grouped by task', () => {
  const s = snapshot({
    [sessionId('web', 'test')]: failed(1),
    [sessionId('web', 'agent', 'abc')]: needsInput(1),
    [sessionId('web', 'lint', 'abc')]: failed(1),
  })
  expect(JSON.parse(attentionCounts(s))).toEqual({ '': 1, abc: 2 })
})

test("worktree attention adds the open project's finished actions not yet seen", () => {
  const activity = (id: string, task: string | null, state: string, projectId = 'p-1') => ({
    id,
    projectId,
    task,
    state,
  })
  const s = {
    ...snapshot({ [sessionId('web', 'agent', 'abc')]: needsInput(1) }),
    project: { id: 'p-1' },
    taskActivities: {
      a: activity('a', 'abc', 'finished'),
      b: activity('b', null, 'failed'),
      c: activity('c', null, 'running'),
      d: activity('d', null, 'finished'),
      e: activity('e', 'abc', 'failed', 'p-2'),
    },
    seenActivities: ['d'],
  } as unknown as Parameters<typeof worktreeAttention>[0]
  expect(JSON.parse(worktreeAttention(s))).toEqual({ abc: 2, '': 1 })
})

test("extension-started terminals count, but only the open project's", () => {
  const ext = sessionId('web', 'ext:lint')
  const runtimeTerminals = {
    [ext]: { projectId: 'p-1', componentId: 'web', terminal: terminal('ext:lint') },
    other: { projectId: 'p-2', componentId: 'web', terminal: terminal('ext:other') },
  }
  const items = attentionItems(
    snapshot({ [ext]: failed(1), other: failed(1) }, { runtimeTerminals }),
  )
  expect(items.map((i) => i.sid)).toEqual([ext])
  expect(
    componentTerminals('web', [terminal('test')], runtimeTerminals).map(([, t]) => t.id),
  ).toEqual(['test', 'ext:lint'])
})

test('mostUrgent ignores statuses that ask for nothing', () => {
  const quiet = { health: 'ok', label: 'Exited', attention: 0 } as const
  const fail = { health: 'fail', label: 'Failed', attention: 3 } as const
  const input = { health: 'input', label: 'Needs input', attention: 4 } as const
  expect(mostUrgent([quiet])).toBeNull()
  expect(mostUrgent([fail, input, quiet])).toBe(input)
})

test('revealing a merge opens Review without switching the source task', async () => {
  const { revealTerminal } = await import('./attention')
  revealTerminal({ componentId: '@merge', sid: 'merge-session' })
  expect(revealState.setView).toHaveBeenCalledWith('review')
  expect(revealState.setActiveSession).toHaveBeenCalledWith('merge-session')
  expect(revealState.setActiveTask).not.toHaveBeenCalled()
})

test('revealing the dependency agent opens Navigation without switching task', async () => {
  const { revealTerminal } = await import('./attention')
  revealState.setActiveTask.mockClear()
  revealTerminal({ componentId: '@map', sid: 'map-session' })
  expect(revealState.setView).toHaveBeenCalledWith('navigation')
  expect(revealState.setActiveSession).toHaveBeenCalledWith('map-session')
  expect(revealState.setActiveTask).not.toHaveBeenCalled()
})

test('recorded merges ask for attention without becoming generic runtime terminals', () => {
  const records = [
    {
      id: 'merge',
      metadata: {
        projectId: 'p-1',
        componentId: '@merge',
        terminalId: 'merge',
        name: 'Merge feature',
        kind: 'agent',
      },
      spec: { command: 'codex', cwd: '/project' },
    },
    {
      id: 'other',
      metadata: {
        projectId: 'p-2',
        componentId: '@merge',
        terminalId: 'other',
        name: 'Other merge',
        kind: 'agent',
      },
      spec: { command: 'codex', cwd: '/project' },
    },
  ]
  const items = attentionItems(
    snapshot({ merge: needsInput(1), other: needsInput(1) }, { sessionRecords: records }),
  )
  expect(items.map((item) => [item.sid, item.owner, item.task])).toEqual([
    ['merge', 'Merge agent', null],
  ])
})

test('merge input is counted on its destination task, including the current task worktree', () => {
  const records = ['task-merge', 'project-merge', 'missing-merge'].map((id, index) => ({
    id,
    metadata: {
      projectId: 'p-1',
      componentId: '@merge',
      terminalId: id,
      name: id,
      kind: 'agent',
    },
    spec: { cwd: ['/task', '/project', '/missing'][index], command: 'codex' },
  }))
  const s = snapshot(Object.fromEntries(records.map((r) => [r.id, needsInput(1)])), {
    sessionRecords: records,
    tasks: [
      { id: 'task', title: 'Destination', worktree: '/task', current: true },
      { id: 'gone', title: 'Missing', worktree: '/missing', missing: true },
    ],
  })
  const items = attentionItems(s)
  expect(items.find((i) => i.sid === 'task-merge')).toMatchObject({
    task: 'task',
    taskTitle: 'Destination',
  })
  expect(items.find((i) => i.sid === 'project-merge')?.task).toBeNull()
  expect(items.find((i) => i.sid === 'missing-merge')?.task).toBeNull()
  expect(JSON.parse(attentionCounts(s))).toEqual({ task: 1, '': 2 })
})

test('reviews appear beside merges and reveal without switching worktrees', async () => {
  vi.clearAllMocks()
  const records = ['@review', '@merge'].map((componentId, index) => ({
    id: `job-${index}`,
    metadata: { projectId: 'p-1', componentId, terminalId: 'job', name: 'Job', kind: 'agent' },
    spec: { cwd: '/task', command: 'claude' },
  }))
  const items = attentionItems(
    snapshot(
      { 'job-0': needsInput(1), 'job-1': needsInput(2) },
      {
        sessionRecords: records,
        tasks: [{ id: 'abc', title: 'Review source', worktree: '/task' }],
      },
    ),
  )
  expect(items.map((i) => [i.owner, i.task])).toEqual([
    ['Review agent', 'abc'],
    ['Merge agent', 'abc'],
  ])
  const { revealTerminal } = await import('./attention')
  revealTerminal(items[0])
  expect(revealState.setView).toHaveBeenCalledWith('review')
  expect(revealState.setActiveSession).toHaveBeenCalledWith('job-0')
  expect(revealState.setActiveTask).not.toHaveBeenCalled()
})
