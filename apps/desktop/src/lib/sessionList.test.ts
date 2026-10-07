import { describe, expect, test } from 'vitest'
import type { SessionRecord, TerminalSnapshot } from '../types'
import {
  DEFAULT_SESSION_LIST_OPTIONS,
  groupByProject,
  projectSessions,
  sessionActivityMs,
  type SessionFilter,
  type SessionListOptions,
  type SessionRow,
  type SessionSort,
} from './sessionList'

const snapshot = (patch: Partial<TerminalSnapshot> = {}): TerminalSnapshot => ({
  truncated: false,
  data: '',
  end: 0,
  generation: 1,
  running: true,
  exitCode: null,
  startedMs: 100,
  exitedMs: null,
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
  ...patch,
})
const record = (id: string, patch: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  metadata: {
    projectId: 'one',
    projectRoot: '/one',
    projectName: 'One',
    componentId: 'app',
    terminalId: id,
    name: id,
    kind: 'task',
    adapter: null,
    conversationId: null,
  },
  snapshot: snapshot(),
  history: [],
  interrupted: false,
  spec: { cwd: '/one', command: 'echo hello' },
  ...patch,
})
const ids = (rows: SessionRow[]) => rows.map((r) => r.record.id)
const choices = (
  filter: SessionFilter = 'all',
  sort: SessionSort = 'latest',
): SessionListOptions => ({ filter, sort })
const defaults = DEFAULT_SESSION_LIST_OPTIONS

const running = record('running')
const ended = record('ended', { snapshot: snapshot({ running: false, exitCode: 0 }) })
const failed = record('failed', { snapshot: snapshot({ running: false, exitCode: 2 }) })
const stopped = record('stopped', {
  snapshot: snapshot({
    running: false,
    exitCode: 137,
    status: { ...snapshot().status, stopped: true },
  }),
})
const interrupted = record('interrupted', {
  snapshot: snapshot({ running: false }),
  interrupted: true,
})
const retained = record('retained', { snapshot: null })
const retainedInterrupted = record('retained-interrupted', { snapshot: null, interrupted: true })
const categories = [running, ended, failed, stopped, interrupted, retained, retainedInterrupted]

describe('projectSessions', () => {
  test('defaults to all sessions with latest activity first', () => {
    expect(DEFAULT_SESSION_LIST_OPTIONS).toEqual({ filter: 'all', sort: 'latest' })
    const newer = record('newer', { snapshot: snapshot({ startedMs: 200 }) })
    expect(ids(projectSessions([ended, newer, running], 'one', defaults))).toEqual([
      'newer',
      'ended',
      'running',
    ])
    expect(projectSessions(categories, 'one', defaults)).toHaveLength(categories.length)
  })

  test('running depends only on the current snapshot running flag', () => {
    const stopping = record('stopping', {
      snapshot: snapshot({ status: { ...snapshot().status, stopped: true } }),
      interrupted: true,
    })
    expect(ids(projectSessions([...categories, stopping], 'one', choices('running')))).toEqual([
      'running',
      'stopping',
    ])
  })

  test('closed includes stopped, ended, failed, interrupted and snapshot-less sessions', () => {
    expect(ids(projectSessions(categories, 'one', choices('closed')))).toEqual([
      'ended',
      'failed',
      'interrupted',
      'stopped',
      'retained',
      'retained-interrupted',
    ])
  })

  test('history cannot make a snapshot-less retained session running', () => {
    const historical = record('historical', { snapshot: null, history: [snapshot()] })
    expect(projectSessions([historical], 'one', choices('running'))).toEqual([])
    expect(ids(projectSessions([historical], 'one', choices('closed')))).toEqual(['historical'])
  })

  test('each project applies its own filter and sort without affecting defaults', () => {
    const a = record('a', { snapshot: snapshot({ startedMs: 100 }) })
    const b = record('b', { snapshot: snapshot({ startedMs: 200 }) })
    const c = record('c', { metadata: { ...a.metadata, projectId: 'two' }, snapshot: b.snapshot })
    const d = record('d', { metadata: c.metadata, snapshot: a.snapshot })
    const closedTwo = record('closed-two', { metadata: c.metadata, snapshot: ended.snapshot })
    const records = [c, b, closedTwo, a, d, ended]
    expect(ids(projectSessions(records, 'one', choices('closed', 'oldest')))).toEqual(['ended'])
    expect(ids(projectSessions(records, 'two', choices('running')))).toEqual(['c', 'd'])
    expect(ids(projectSessions(records, 'one', choices('running', 'oldest')))).toEqual(['a', 'b'])
    expect(ids(projectSessions(records, 'two', defaults))).toEqual(['c', 'closed-two', 'd'])
    expect(projectSessions(records, 'unknown', defaults)).toEqual([])
    expect([...groupByProject(records).keys()]).toEqual(['two', 'one'])
    expect(
      groupByProject(records)
        .get('two')!
        .map((r) => r.id),
    ).toEqual(['c', 'closed-two', 'd'])
  })

  test.each<SessionSort>(['latest', 'oldest'])(
    '%s puts missing timestamps last and breaks all ties by session ID',
    (sort) => {
      const a = record('a')
      const b = record('b')
      const newest = record('newest', { snapshot: snapshot({ exitedMs: 300 }) })
      const missingA = record('missing-a', { snapshot: null })
      const missingB = record('missing-b', { snapshot: null })
      const records = [missingB, b, newest, missingA, a]
      const timed = sort === 'latest' ? ['newest', 'a', 'b'] : ['a', 'b', 'newest']
      expect(ids(projectSessions(records, 'one', choices('all', sort)))).toEqual([
        ...timed,
        'missing-a',
        'missing-b',
      ])
      expect(ids(projectSessions([...records].reverse(), 'one', choices('all', sort)))).toEqual([
        ...timed,
        'missing-a',
        'missing-b',
      ])
    },
  )

  test('live output updates the shown activity without reordering rows', () => {
    const quiet = record('quiet', { snapshot: snapshot({ startedMs: 200 }) })
    const chatty = record('chatty', {
      snapshot: snapshot({ startedMs: 100, status: { ...snapshot().status, lastOutputMs: 900 } }),
    })
    const rows = projectSessions([chatty, quiet], 'one', defaults)
    expect(ids(rows)).toEqual(['quiet', 'chatty'])
    expect(rows.map((r) => r.activity)).toEqual([200, 900])
  })

  test('does not mutate input arrays, snapshots, histories, records or choices', () => {
    const records = [retained, running, ended]
    const preferences = choices('closed', 'oldest')
    const before = structuredClone({ records, preferences })
    const freeze = (value: object) => {
      Object.freeze(value)
      for (const child of Object.values(value)) {
        if (child && typeof child === 'object') freeze(child)
      }
    }
    freeze(records)
    freeze(preferences)
    const result = projectSessions(records, 'one', preferences)
    expect({ records, preferences }).toEqual(before)
    expect(result).not.toBe(records)
    expect(result[0].record).toBe(ended)
    expect(result[1].record).toBe(retained)
  })
})

describe('sessionActivityMs', () => {
  test.each([
    { startedMs: 300, outputMs: 100, exitedMs: 200, expected: 300 },
    { startedMs: 100, outputMs: 300, exitedMs: 200, expected: 300 },
    { startedMs: 100, outputMs: 200, exitedMs: 300, expected: 300 },
    { startedMs: 100, outputMs: null, exitedMs: null, expected: 100 },
    { startedMs: 0, outputMs: null, exitedMs: null, expected: 0 },
  ])('selects the latest current start/output/exit time: %j', (times) => {
    const current = snapshot({
      startedMs: times.startedMs,
      exitedMs: times.exitedMs,
      status: { ...snapshot().status, lastOutputMs: times.outputMs },
    })
    expect(sessionActivityMs(record('current', { snapshot: current }))).toBe(times.expected)
  })

  test('current snapshot takes precedence over newer historical activity', () => {
    expect(sessionActivityMs(record('current', { history: [snapshot({ exitedMs: 900 })] }))).toBe(
      100,
    )
  })

  test('snapshot-less history uses the latest timestamp across all runs, regardless of order', () => {
    const history = [
      snapshot({ startedMs: 100, exitedMs: 700 }),
      snapshot({ startedMs: 200, status: { ...snapshot().status, lastOutputMs: 900 } }),
      snapshot({ startedMs: 800 }),
    ]
    expect(sessionActivityMs(record('history', { snapshot: null, history }))).toBe(900)
    expect(
      sessionActivityMs(record('history', { snapshot: null, history: [...history].reverse() })),
    ).toBe(900)
  })

  test('records without a current snapshot or history have no activity timestamp', () => {
    expect(sessionActivityMs(retained)).toBeUndefined()
  })
})
