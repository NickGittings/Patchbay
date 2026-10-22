import { expect, test } from 'vitest'
import { activeComponents, activityFile, fileActivity, hydrateActivity } from './activity'
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
  ).toEqual({ componentId: 'external', path: '/external/lib/a.rs' })
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
  expect([...activeComponents([record()], sessions, 'p', 't', '/task', components, 11000)]).toEqual(
    ['src'],
  )
  expect([...activeComponents([record()], sessions, 'p', 't', '/task', components, 11001)]).toEqual(
    [],
  )
  expect([
    ...activeComponents([record()], sessions, 'other', 't', '/task', components, 1000),
  ]).toEqual([])
  expect([
    ...activeComponents([record('/other')], sessions, 'p', 'other', '/other', components, 1000),
  ]).toEqual(['src'])
  expect([
    ...activeComponents([record()], sessions, 'p', 'other', '/other', components, 1000),
  ]).toEqual([])
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
