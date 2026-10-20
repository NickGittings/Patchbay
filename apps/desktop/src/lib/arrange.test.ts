import { beforeEach, expect, test, vi } from 'vitest'
import { appendToMap, moveComponents, projectStateOf, useStore, type ProjectEntry } from '../store'
import type { Component, Project } from '../types'
import { arrangeMap, arrangeNow, onArranged, undoArrange } from './arrange'

const state = () => useStore.getState()
const positions = () => Object.fromEntries(state().nodes.map((n) => [n.id, n.position]))
const component = (id: string, x: number, y: number): Component => ({
  id,
  name: id,
  kind: 'other',
  path: '.',
  notes: '',
  position: { x, y },
  terminals: [],
})
const map = (id = 'one'): Project => ({
  projectId: id,
  schemaVersion: 4,
  root: `/tmp/${id}`,
  name: id,
  components: [component('app', 0, 0), component('api', 20, 40), component('jobs', 50, 80)],
  links: [{ id: 'app->api', source: 'app', target: 'api' }],
})
function arranged() {
  const arrangement = arrangeMap('one')
  expect(arrangement).not.toBeNull()
  state().markSaved()
  return arrangement!
}

beforeEach(() => {
  useStore.setState(useStore.getInitialState(), true)
  useStore.setState({ restoring: false })
  state().loadProject(map())
})

test('Undo restores positions while retaining links and other later edits', () => {
  const before = positions()
  const arrangement = arranged()
  state().updateComponent('api', { notes: 'edited later' })
  appendToMap('one', () => ({ links: [{ id: 'jobs->api', source: 'jobs', target: 'api' }] }))
  undoArrange('one', arrangement).run()
  expect(positions()).toEqual(before)
  expect(state().nodes.find((n) => n.id === 'api')?.data.notes).toBe('edited later')
  expect(state().edges.map((e) => e.id)).toEqual(['app->api', 'jobs->api'])
  expect(state().dirty).toBe(true)
  expect(state().message).toBe('Restored the previous layout')
})

test('Undo preserves later drags, including subpixel positions, while restoring untouched nodes', () => {
  const before = positions()
  const arrangement = arranged()
  const later = { x: arrangement.after.api.x + 0.1, y: arrangement.after.api.y }
  state().onNodesChange([{ id: 'api', type: 'position', position: later, dragging: false }])
  undoArrange('one', arrangement).run()
  expect(positions()).toEqual({ ...before, api: later })
  expect(state().message).toBe('Restored previous positions; kept later layout edits')
})

test('Undo skips an active drag without clearing its dragging state or measured dimensions', () => {
  const arrangement = arranged()
  state().onNodesChange([
    { id: 'api', type: 'dimensions', dimensions: { width: 280, height: 150 } },
    { id: 'api', type: 'position', dragging: true },
  ])
  undoArrange('one', arrangement).run()
  expect(state().nodes.find((n) => n.id === 'api')).toMatchObject({
    position: arrangement.after.api,
    dragging: true,
    measured: { width: 280, height: 150 },
  })
})

test('Undo ignores removed nodes and leaves components added later in place', () => {
  const arrangement = arranged()
  const later = component('new', 999, 333)
  appendToMap('one', () => ({ components: [later] }))
  state().patchProject('one', { nodes: state().nodes.filter((n) => n.id !== 'api') })
  undoArrange('one', arrangement).run()
  expect(positions().api).toBeUndefined()
  expect(positions().new).toEqual(later.position)
  expect(state().message).toBe('Restored the previous layout')
})

test('Undo reports nothing to restore when all arranged components were deleted', () => {
  const arrangement = arranged()
  state().patchProject('one', {
    nodes: state().nodes.filter((n) => !arrangement.before[n.id]),
  })
  state().markSaved()
  undoArrange('one', arrangement).run()
  expect(state().message).toBe('No layout positions to restore')
  expect(state().dirty).toBe(false)
})

test('Undo reports no change without making the map dirty when all moved nodes were edited', () => {
  const arrangement = arranged()
  moveComponents(
    'one',
    Object.fromEntries(Object.keys(arrangement.before).map((id) => [id, { x: 2000, y: 3000 }])),
  )
  const before = state().nodes
  state().markSaved()
  undoArrange('one', arrangement).run()
  expect(state().nodes).toBe(before)
  expect(state().dirty).toBe(false)
  expect(state().message).toBe('No layout positions to restore; kept later edits')
})

for (const blocked of [
  { conflict: map() },
  { mapSave: { status: 'conflict' as const } },
  { unavailable: 'Missing folder' },
] satisfies Partial<ProjectEntry>[]) {
  test(`arranging and Undo refuse blocked maps: ${JSON.stringify(blocked)}`, () => {
    const arrangement = arranged()
    useStore.setState((s) => ({
      projects: { ...s.projects, one: { ...s.projects.one, ...blocked } },
    }))
    const before = state().nodes
    expect(arrangeMap('one')).toBeNull()
    arrangeNow('one')
    expect(state().message).toContain('before arranging')
    undoArrange('one', arrangement).run()
    expect(state().nodes).toBe(before)
    expect(state().dirty).toBe(false)
    expect(state().message).toContain('before undoing')
  })
}

test('toast Undo is bound to its project, including stale callbacks', () => {
  arrangeNow('one')
  const action = state().messageAction!
  const first = state().nodes
  expect(action.projectId).toBe('one')
  state().loadProject(map('two'))
  const second = state().nodes
  action.run()
  expect(state().nodes).toBe(second)
  expect(projectStateOf('one')?.nodes).toBe(first)
  state().activateProject('one')
  action.run()
  expect(state().message).toBe('Restored the previous layout')
})

test('setMessage guards other project actions after switching tabs', () => {
  const run = vi.fn()
  state().setMessage('Action', true, { label: 'Do it', run })
  const action = state().messageAction!
  state().loadProject(map('two'))
  action.run()
  expect(run).not.toHaveBeenCalled()
})

for (const count of [0, 1]) {
  test(`arrange explains when there are only ${count} components`, () => {
    state().patchProject('one', { nodes: state().nodes.slice(0, count) })
    arrangeNow('one')
    expect(state().message).toBe('Add at least two components before arranging the map')
    expect(state().dirty).toBe(false)
  })
}

test('an already arranged map does not become dirty or emit an animation', () => {
  arranged()
  const listener = vi.fn()
  const stop = onArranged(listener)
  arrangeNow('one')
  stop()
  expect(listener).not.toHaveBeenCalled()
  expect(state().message).toBe('The map is already arranged')
  expect(state().dirty).toBe(false)
})

test('a cyclic map does not become dirty or animate on a second arrangement', () => {
  appendToMap('one', () => ({ links: [{ id: 'api->app', source: 'api', target: 'app' }] }))
  arranged()
  const listener = vi.fn()
  const stop = onArranged(listener)
  arrangeNow('one')
  stop()
  expect(listener).not.toHaveBeenCalled()
  expect(state().message).toBe('The map is already arranged')
  expect(state().dirty).toBe(false)
})

test('append and move edits preserve live state and dirty handling in inactive tabs', () => {
  state().select('api')
  state().onNodesChange([{ id: 'api', type: 'select', selected: true }])
  state().setSession('terminal', { running: true })
  const live = state().sessions
  state().loadProject(map('two'))
  const active = state().nodes
  const later = component('new', 999, 333)
  appendToMap('one', () => ({ components: [later] }))
  moveComponents('one', { api: { x: 123.5, y: 456.5 } })
  expect(state().nodes).toBe(active)
  expect(state().dirty).toBe(false)
  expect(projectStateOf('one')?.dirty).toBe(true)
  state().activateProject('one')
  expect(positions().new).toEqual(later.position)
  expect(positions().api).toEqual({ x: 123.5, y: 456.5 })
  expect(state().selectedId).toBe('api')
  expect(state().nodes.find((n) => n.id === 'api')?.selected).toBe(true)
  expect(state().sessions).toBe(live)
})
