import { expect, test, vi } from 'vitest'
import type { SessionState, TerminalSpec } from '../types'
import { PLAN_SCOPE, sessionId, setProjectIdentity } from '../types'

vi.mock('../store', () => ({ useStore: { getState: () => ({ project: { id: 'p-1' } }) } }))
const { attentionCounts, attentionItems, componentTerminals, mostUrgent } =
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
