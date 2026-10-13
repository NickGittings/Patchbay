import { describe, expect, test } from 'vitest'
import {
  PLAN_SCOPE,
  REVIEW_SCOPE,
  MERGE_SCOPE,
  TASK_ROOT_SCOPE,
  type SessionRecord,
  type Task,
  type TerminalSnapshot,
} from '../types'
import {
  DEFAULT_SESSION_LIST_OPTIONS,
  groupByProject,
  groupByWorktree,
  projectSessions,
  sessionLive,
  sessionRole,
  subject,
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

describe('session labels', () => {
  test.each([
    { componentId: PLAN_SCOPE, kind: 'agent', role: 'Planner', tone: 'plan' },
    { componentId: REVIEW_SCOPE, kind: 'agent', role: 'Review', tone: 'review' },
    { componentId: MERGE_SCOPE, kind: 'agent', role: 'Merge', tone: 'merge' },
    { componentId: TASK_ROOT_SCOPE, kind: 'agent', role: 'Implementation', tone: 'implement' },
    { componentId: 'api', kind: 'agent', role: 'Implementation', tone: 'implement' },
    { componentId: 'web', kind: 'task', role: 'Task', tone: 'task' },
    { componentId: 'api', kind: 'shell', role: 'Shell', tone: 'shell' },
    { componentId: TASK_ROOT_SCOPE, kind: 'shell', role: 'Shell', tone: 'shell' },
  ] as const)('$componentId/$kind leads with $role', ({ componentId, kind, role, tone }) => {
    expect(sessionRole({ ...running.metadata, componentId, kind })).toEqual({ role, tone })
  })

  test.each(['agent', 'task', 'shell'] as const)('extension takes precedence over %s', (kind) => {
    expect(sessionRole({ ...running.metadata, kind, extensionId: 'docker' })).toEqual({
      role: 'Extension',
      tone: 'task',
    })
  })

  test.each(['agent', 'task', 'shell'] as const)('%s names its component', (kind) => {
    expect(subject({ ...running.metadata, componentId: 'api', kind, branch: 'feature-x' })).toBe(
      'api',
    )
  })

  test('review names its branch when recorded', () => {
    expect(subject({ ...running.metadata, componentId: REVIEW_SCOPE, branch: 'feature-x' })).toBe(
      'feature-x',
    )
    expect(
      subject({ ...running.metadata, componentId: REVIEW_SCOPE, branch: null }),
    ).toBeUndefined()
    expect(subject({ ...running.metadata, componentId: REVIEW_SCOPE })).toBeUndefined()
  })

  test.each([PLAN_SCOPE, MERGE_SCOPE, TASK_ROOT_SCOPE])('%s has no subject', (componentId) => {
    expect(subject({ ...running.metadata, componentId, branch: 'feature-x' })).toBeUndefined()
  })
})

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

describe('groupByWorktree', () => {
  const task = (id: string, title: string): Task => ({
    id,
    title,
    worktree: `/worktrees/${id}`,
    components: [],
    notes: '',
    createdMs: 0,
    missing: false,
    current: false,
  })
  const inTask = (id: string, taskId: string | null | undefined, startedMs = 100, title?: string) =>
    record(id, {
      metadata: {
        ...running.metadata,
        task: taskId,
        taskTitle: title,
        projectRoot: taskId ? `/worktrees/${taskId}/project` : '/one/project',
      },
      snapshot: snapshot({ startedMs }),
      spec: { cwd: `/components/${id}`, command: 'echo hello' },
    })

  test('known tasks supply branches without borrowing a review branch or another task branch', () => {
    const records = [inTask('main', null), inTask('known', 'known'), inTask('unknown', 'unknown')]
    records[0].metadata.branch = 'reviewed-branch'
    const tasks = [{ ...task('known', 'Known'), branch: 'feature-x' }]
    expect(groupByWorktree(records, defaults, tasks).map((g) => [g.task, g.branch])).toEqual([
      [null, undefined],
      ['known', 'feature-x'],
      ['unknown', undefined],
    ])
  })

  test('retained names order closed-project worktrees by title, with main first and id ties', () => {
    const records = [
      inTask('z', 'z', 100, 'Zebra'),
      inTask('b', 'b', 100, 'Alpha'),
      inTask('a', 'a', 100, 'Alpha'),
      inTask('null', null),
      inTask('legacy', undefined),
    ]
    const groups = groupByWorktree(records, defaults)
    expect(groups.map((g) => [g.task, g.title, g.path, ids(g.rows)])).toEqual([
      [null, 'Main worktree', '/one/project', ['legacy', 'null']],
      ['a', 'Alpha', '/worktrees/a/project', ['a']],
      ['b', 'Alpha', '/worktrees/b/project', ['b']],
      ['z', 'Zebra', '/worktrees/z/project', ['z']],
    ])
    expect(groupByWorktree([...records].reverse(), defaults)).toEqual(groups)
  })

  test('cached task lists supply only legacy titles; retained project folders always supply paths', () => {
    const records = [inTask('a', 'a'), inTask('b', 'b', 100, 'Recorded title')]
    const tasks = [task('a', 'Legacy title'), task('b', 'Changed title')]
    expect(groupByWorktree(records, defaults, tasks).map((g) => [g.title, g.path])).toEqual([
      ['Legacy title', '/worktrees/a/project'],
      ['Recorded title', '/worktrees/b/project'],
    ])
    expect(
      groupByWorktree(records, defaults)
        .map((g) => g.path)
        .sort(),
    ).toEqual(
      groupByWorktree(records, defaults, tasks)
        .map((g) => g.path)
        .sort(),
    )
  })

  test('legacy records without task metadata identify the folder instead of the internal task id', () => {
    expect(groupByWorktree([inTask('a', 'removed')], defaults)[0]).toMatchObject({
      title: 'Worktree · project',
      path: '/worktrees/removed/project',
    })
  })

  test.each<SessionSort>(['latest', 'oldest'])(
    '%s keeps paths and titles stable across All, Running and Closed after a move',
    (sort) => {
      const old = {
        ...inTask('old', 't', 100, 'Old title'),
        snapshot: snapshot({ running: false }),
      }
      const newer = {
        ...inTask('new', 't', 200, 'New title'),
        metadata: {
          ...inTask('new', 't', 200, 'New title').metadata,
          projectRoot: '/moved/project',
        },
      }
      const mainOld = { ...inTask('main-old', null, 100), snapshot: snapshot({ running: false }) }
      const mainNew = {
        ...inTask('main-new', null, 200),
        metadata: { ...running.metadata, projectRoot: '/main-moved/project' },
      }
      for (const filter of ['all', 'running', 'closed'] as const) {
        const groups = groupByWorktree([old, newer, mainOld, mainNew], choices(filter, sort))
        expect(groups.map((g) => [g.title, g.path])).toEqual([
          ['Main worktree', '/main-moved/project'],
          ['New title', '/moved/project'],
        ])
        if (filter !== 'all') expect(groups.every((g) => g.rows.length === 1)).toBe(true)
      }
    },
  )

  test('legacy paths and retained-title ties are stable regardless of record order or filters', () => {
    const a = { ...inTask('a', 'gone', 100, 'Alpha'), snapshot: snapshot({ running: false }) }
    const b = {
      ...inTask('b', 'gone', 100, 'Beta'),
      metadata: { ...a.metadata, taskTitle: 'Beta', projectRoot: '/other' },
    }
    for (const records of [
      [a, b],
      [b, a],
    ]) {
      for (const filter of ['all', 'running', 'closed'] as const) {
        expect(groupByWorktree(records, choices(filter))[0]).toMatchObject({
          title: 'Alpha',
          path: '/worktrees/gone/project',
        })
      }
    }
  })

  test.each<SessionSort>(['latest', 'oldest'])('keeps %s ordering inside each worktree', (sort) => {
    const groups = groupByWorktree(
      [
        inTask('main-old', null, 100),
        inTask('task-new', 't', 400),
        inTask('task-old', 't', 200),
        inTask('main-new', null, 300),
      ],
      choices('all', sort),
      [task('t', 'Task')],
    )
    expect(groups.map((g) => ids(g.rows))).toEqual(
      sort === 'latest'
        ? [
            ['main-new', 'main-old'],
            ['task-new', 'task-old'],
          ]
        : [
            ['main-old', 'main-new'],
            ['task-old', 'task-new'],
          ],
    )
  })

  test('filters hide empty worktrees and repositories retain their own groups', () => {
    const closed = { ...inTask('closed', 'closed'), snapshot: snapshot({ running: false }) }
    const otherRepo = {
      ...inTask('other', 'live'),
      metadata: { ...running.metadata, projectId: 'two', task: 'live' },
    }
    const repos = groupByProject([closed, inTask('live', 'live'), otherRepo])
    expect(
      repos.map((repo) =>
        groupByWorktree(repo.records, choices('running')).map((w) => ids(w.rows)),
      ),
    ).toEqual([[['live']], [['other']]])
    expect(groupByWorktree([closed], choices('running'))).toEqual([])
  })

  test('does not mutate records, options or legacy task metadata', () => {
    const records = [inTask('b', 'b'), inTask('a', 'a')]
    const tasks = [task('b', 'Beta'), task('a', 'Alpha')]
    const options = choices('closed')
    const before = structuredClone({ records, tasks, options })
    Object.freeze(records)
    Object.freeze(tasks)
    Object.freeze(options)
    groupByWorktree(records, options, tasks)
    expect({ records, tasks, options }).toEqual(before)
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
