import { describe, expect, test } from 'vitest'
import type { SessionRecord, TerminalSnapshot } from '../types'
import {
  DEFAULT_SESSION_LIST_OPTIONS,
  groupByProject,
  projectSessions,
  sessionLive,
  sessionTimeMs,
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
// Recorded, not spawned yet.
const starting = record('starting', { snapshot: null })
// Saved mid-launch; the service marks it interrupted on load.
const retained = record('retained', { snapshot: null, interrupted: true })
const categories = [running, ended, failed, stopped, interrupted, starting, retained]

describe('projectSessions', () => {
  test('defaults to all sessions, most recently started or exited first', () => {
    expect(DEFAULT_SESSION_LIST_OPTIONS).toEqual({ filter: 'all', sort: 'latest' })
    const newer = record('newer', { snapshot: snapshot({ startedMs: 200 }) })
    expect(ids(projectSessions([ended, newer, running], defaults))).toEqual([
      'newer',
      'ended',
      'running',
    ])
    expect(projectSessions(categories, defaults)).toHaveLength(categories.length)
  })

  test('running holds running and still-starting sessions', () => {
    const stopping = record('stopping', {
      snapshot: snapshot({ status: { ...snapshot().status, stopped: true } }),
      interrupted: true,
    })
    expect(ids(projectSessions([...categories, stopping], choices('running')))).toEqual([
      'running',
      'stopping',
      'starting',
    ])
  })

  test('closed holds stopped, ended, failed, interrupted and retained sessions', () => {
    expect(ids(projectSessions(categories, choices('closed')))).toEqual([
      'ended',
      'failed',
      'interrupted',
      'stopped',
      'retained',
    ])
  })

  test('the current snapshot decides liveness over history and the interrupted flag', () => {
    expect(sessionLive(record('h', { snapshot: null, history: [snapshot()] }))).toBe(true)
    expect(
      sessionLive(record('h', { snapshot: null, interrupted: true, history: [snapshot()] })),
    ).toBe(false)
    expect(sessionLive(record('r', { interrupted: true }))).toBe(true)
    expect(sessionLive(ended)).toBe(false)
  })

  test('live output neither reorders rows nor changes their shown time', () => {
    const quiet = record('quiet', { snapshot: snapshot({ startedMs: 200 }) })
    const chatty = record('chatty', {
      snapshot: snapshot({ startedMs: 100, status: { ...snapshot().status, lastOutputMs: 900 } }),
    })
    const rows = projectSessions([chatty, quiet], defaults)
    expect(ids(rows)).toEqual(['quiet', 'chatty'])
    expect(rows.map((r) => r.time)).toEqual([200, 100])
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
      const expected = [...timed, 'missing-a', 'missing-b']
      expect(ids(projectSessions(records, choices('all', sort)))).toEqual(expected)
      expect(ids(projectSessions([...records].reverse(), choices('all', sort)))).toEqual(expected)
    },
  )

  test('does not mutate input arrays, snapshots, histories, records or options', () => {
    const records = [retained, running, ended]
    const options = choices('closed', 'oldest')
    const before = structuredClone({ records, options })
    const freeze = (value: object) => {
      Object.freeze(value)
      for (const child of Object.values(value)) {
        if (child && typeof child === 'object') freeze(child)
      }
    }
    freeze(records)
    freeze(options)
    const result = projectSessions(records, options)
    expect({ records, options }).toEqual(before)
    expect(result[0].record).toBe(ended)
    expect(result[1].record).toBe(retained)
  })
})

describe('groupByProject', () => {
  test('groups by project id, ordered by name regardless of record order', () => {
    const inTwo = (id: string, projectName = 'Alpha') =>
      record(id, { metadata: { ...running.metadata, projectId: 'two', projectName } })
    const records = [running, inTwo('c'), ended, inTwo('d')]
    const groups = groupByProject(records)
    expect(groups.map((g) => [g.projectId, g.projectName])).toEqual([
      ['two', 'Alpha'],
      ['one', 'One'],
    ])
    expect(groups.map((g) => g.records.map((r) => r.id))).toEqual([
      ['c', 'd'],
      ['running', 'ended'],
    ])
    expect(groupByProject([...records].reverse()).map((g) => g.projectId)).toEqual(['two', 'one'])
  })

  test('projects sharing a name keep a stable order by id', () => {
    const named = (projectId: string) =>
      record(projectId, { metadata: { ...running.metadata, projectId, projectName: 'Same' } })
    expect(groupByProject([named('b'), named('a')]).map((g) => g.projectId)).toEqual(['a', 'b'])
  })
})

describe('sessionTimeMs', () => {
  test.each([
    { startedMs: 300, exitedMs: 200, expected: 300 },
    { startedMs: 100, exitedMs: 300, expected: 300 },
    { startedMs: 100, exitedMs: null, expected: 100 },
    { startedMs: 0, exitedMs: null, expected: 0 },
  ])('selects the latest current start/exit time: %j', ({ startedMs, exitedMs, expected }) => {
    const current = snapshot({
      startedMs,
      exitedMs,
      status: { ...snapshot().status, lastOutputMs: 900 },
    })
    expect(sessionTimeMs(record('current', { snapshot: current }))).toBe(expected)
  })

  test('current snapshot takes precedence over newer historical times', () => {
    expect(sessionTimeMs(record('current', { history: [snapshot({ exitedMs: 900 })] }))).toBe(100)
  })

  test('snapshot-less history uses the latest time across all runs, regardless of order', () => {
    const history = [
      snapshot({ startedMs: 100, exitedMs: 700 }),
      snapshot({ startedMs: 200 }),
      snapshot({ startedMs: 800 }),
    ]
    expect(sessionTimeMs(record('history', { snapshot: null, history }))).toBe(800)
    expect(
      sessionTimeMs(record('history', { snapshot: null, history: [...history].reverse() })),
    ).toBe(800)
  })

  test('ignores times a Date cannot hold', () => {
    expect(
      sessionTimeMs(record('huge', { snapshot: snapshot({ startedMs: 9e15 }) })),
    ).toBeUndefined()
  })

  test('records without a current snapshot or history have no time', () => {
    expect(sessionTimeMs(retained)).toBeUndefined()
  })
})
