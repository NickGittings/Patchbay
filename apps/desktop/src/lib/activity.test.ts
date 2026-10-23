import { expect, test } from 'vitest'
import {
  activityFile,
  agentRole,
  componentActivity,
  fileActivity,
  hydrateActivity,
  liveComponents,
  writeActivity,
} from './activity'
import type { Activity, SessionRecord } from '../types'
const activity = (sequence = 1, target = 'src/lib.rs', tool = 'Edit'): Activity => ({
  sequence,
  atMs: 1000,
  tool,
  target,
  turn: 'turn',
  fileTarget: true,
})
const record = (cwd = '/task'): SessionRecord =>
  ({
    id: 's',
    metadata: { projectId: 'p', task: 't', componentId: 'app' },
    spec: { cwd },
  }) as SessionRecord
const components = [
  { id: 'root', path: '.' },
  { id: 'src', path: 'src' },
  { id: 'nested', path: 'src/nested' },
  { id: 'external', path: '/external/lib' },
]
test('activity hydration deduplicates races, retains newest fifty, and clears across generations', () => {
  const previous = { generation: 2, running: true, activity: [activity(2), activity(3)] }
  expect(hydrateActivity(previous, 2, [activity(1), activity(2)]).map((a) => a.sequence)).toEqual([
    1, 2, 3,
  ])
  expect(hydrateActivity(previous, 1, [activity(100)])).toEqual(previous.activity)
  expect(hydrateActivity(previous, 3, [])).toEqual([])
  expect(
    hydrateActivity(
      undefined,
      1,
      Array.from({ length: 60 }, (_, i) => activity(i)),
    ).map((a) => a.sequence),
  ).toEqual(Array.from({ length: 50 }, (_, i) => i + 10))
})
test('file ownership uses longest directory boundary including nested and external components', () => {
  expect(activityFile(activity(1, 'src/nested/file.ts'), record(), components, '/task')).toEqual({
    componentId: 'nested',
    path: 'src/nested/file.ts',
  })
  expect(
    activityFile(activity(1, 'src/nestedness/file.ts'), record(), components, '/task')?.componentId,
  ).toBe('src')
  expect(
    activityFile(activity(1, '/external/lib/a.rs'), record('/external/lib'), components, '/task'),
  ).toEqual({ componentId: 'external', path: '../external/lib/a.rs' })
  expect(
    activityFile(activity(1, 'a.rs'), record('/task/src/nested'), components, '/task')?.componentId,
  ).toBe('nested')
  expect(
    activityFile(activity(1, '../lib/a.rs'), record('/external/other'), components, '/task')
      ?.componentId,
  ).toBe('external')
  expect(
    activityFile(activity(1, '/unrelated/src/lib.rs'), record(), components, '/task'),
  ).toBeUndefined()
})
test('commands, patch bodies, unknown tools, and untyped legacy targets cannot become paths', () => {
  expect(fileActivity(activity(1, 'src/lib.rs', 'Bash'))).toBe(false)
  expect(
    activityFile(
      { ...activity(1, 'src/lib.rs'), fileTarget: false },
      record(),
      components,
      '/task',
    ),
  ).toBeUndefined()
  expect(
    activityFile(activity(1, 'src/lib.rs', 'Unknown'), record(), components, '/task'),
  ).toBeUndefined()
})
test('pulses belong to this project/worktree and expire after ten seconds', () => {
  const sessions = { s: { generation: 1, running: true, activity: [activity()] } }
  const live = (...args: Parameters<typeof componentActivity>) =>
    liveComponents(componentActivity(...args))
  expect(live([record()], sessions, 'p', 't', '/task', components, 11000)).toEqual(['src'])
  expect(live([record()], sessions, 'p', 't', '/task', components, 11001)).toEqual([])
  expect(live([record()], sessions, 'other', 't', '/task', components, 1000)).toEqual([])
  expect(live([record('/other')], sessions, 'p', 'other', '/other', components, 1000)).toEqual([
    'src',
  ])
  expect(live([record()], sessions, 'p', 'other', '/other', components, 1000)).toEqual([])
})

test('shared planner and review activity resolve in their own worktree before opening the selected diff', async () => {
  const { activityRoot } = await import('./activity')
  const planner = {
    ...record('/project'),
    metadata: { ...record().metadata, componentId: '@plan', projectRoot: '/project', task: null },
  }
  const root = activityRoot(planner, [], '/selected')
  expect(activityFile(activity(1, '/project/src/app.ts'), planner, components, root)).toEqual({
    componentId: 'src',
    path: 'src/app.ts',
  })
  const reviewer = {
    ...record('/task'),
    metadata: { ...record().metadata, componentId: '@review', projectRoot: '/project', task: null },
  }
  expect(activityRoot(reviewer, [], '/selected')).toBe('/task')
})

test('sessions map to their role agent, and the dependency mapper to none', () => {
  const scoped = (componentId: string, branch?: string) =>
    ({ ...record(), metadata: { ...record().metadata, componentId, branch } }) as SessionRecord
  expect(agentRole(scoped('@plan'))).toBe('plan')
  expect(agentRole(scoped('@task'))).toBe('build')
  expect(agentRole(scoped('@task', 'feature'))).toBe('fix')
  expect(agentRole(scoped('@review'))).toBe('review')
  expect(agentRole(scoped('@merge'))).toBe('merge')
  expect(agentRole(scoped('app'))).toBe('build')
  expect(agentRole(scoped('@map'))).toBeNull()
})

test('component activity groups each session’s files per component and marks it live for ten seconds', () => {
  const builder = {
    ...record(),
    id: 'b',
    metadata: { ...record().metadata, componentId: '@task' },
  } as SessionRecord
  const reviewer = {
    ...record(),
    id: 'r',
    metadata: { ...record().metadata, componentId: '@review' },
  } as SessionRecord
  const sessions = {
    b: {
      generation: 1,
      running: true,
      activity: [activity(1, 'src/a.ts'), activity(2, 'src/a.ts'), activity(3, 'src/b.ts')],
    },
    r: {
      generation: 1,
      running: true,
      activity: [
        { ...activity(1, 'src/nested/c.ts', 'Write'), atMs: 5000 },
        { ...activity(2, 'src/nested/d.ts', 'Read'), atMs: 5000 },
      ],
    },
  }
  const found = componentActivity(
    [builder, reviewer],
    sessions,
    'p',
    't',
    '/task',
    components,
    12000,
  )
  expect(found.get('src')).toEqual([
    {
      role: 'build',
      sessionId: 'b',
      scope: '@task',
      lastMs: 1000,
      live: false,
      paths: ['src/a.ts', 'src/b.ts'],
    },
  ])
  expect(found.get('nested')).toEqual([
    {
      role: 'review',
      sessionId: 'r',
      scope: '@review',
      lastMs: 5000,
      live: true,
      paths: ['src/nested/c.ts'],
    },
  ])
  expect(liveComponents(found)).toEqual(['nested'])
})

test('external component files are named relative to the worktree, as file trees name them', () => {
  const sibling = [{ id: 'billing', path: '../billing' }]
  const sessions = {
    s: { generation: 1, running: true, activity: [activity(1, '/work/billing/src/pay.ts')] },
  }
  const found = componentActivity(
    [record('/work/app')],
    sessions,
    'p',
    't',
    '/work/app',
    sibling,
    1000,
  )
  expect(found.get('billing')?.[0].paths).toEqual(['../billing/src/pay.ts'])
  // No relative path reaches another drive.
  expect(
    activityFile(
      activity(1, 'C:/lib/a.ts'),
      record('C:/lib'),
      [{ id: 'o', path: 'C:/lib' }],
      'D:/x',
    )?.path,
  ).toBe('C:/lib/a.ts')
})

test('only writes mark components: reading a file is not working on it', () => {
  const sessions = {
    s: { generation: 1, running: true, activity: [activity(1, 'src/a.ts', 'Read')] },
  }
  expect(componentActivity([record()], sessions, 'p', 't', '/task', components, 1000).size).toBe(0)
  expect(writeActivity(activity(1, 'src/a.ts', 'Read'))).toBe(false)
  expect(writeActivity(activity(1, 'src/a.ts', 'MultiEdit'))).toBe(true)
  expect(fileActivity(activity(1, 'src/a.ts', 'Read'))).toBe(true)
})
