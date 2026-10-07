import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
vi.mock('./ipc', () => ({ quitPatchbay: vi.fn(), workspaceLoad: vi.fn(), workspaceSave: vi.fn() }))
vi.mock('./windows', () => ({ openComponentWindow: vi.fn() }))
vi.mock('./sessions', () => ({ reconcileSessions: vi.fn() }))
const { workspaceDocument, restoredLayout } = await import('./workspace')
beforeEach(() => {
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    root: '/p',
    name: 'P',
    schemaVersion: 4,
    links: [],
    components: ['a', 'b', 'c'].map((id) => ({
      id,
      name: id,
      path: id,
      kind: 'app',
      notes: '',
      terminals: [],
      position: { x: 0, y: 0 },
    })),
  })
})
test('pills and groups retain one order when toggled through Plan', () => {
  const s = useStore.getState()
  s.toggleHighlight('b')
  s.toggleHighlight('a')
  s.toggleHighlight('b')
  expect(useStore.getState().implementationComponents).toEqual([
    { id: 'b', visible: false },
    { id: 'a', visible: true },
  ])
  s.toggleHighlight('b')
  expect(useStore.getState().highlighted).toEqual(['b', 'a'])
})
test('entering Implementation restores the selection after hide or removal', () => {
  const s = useStore.getState()
  s.setImplementationScope([])
  s.select('c')
  s.setView('implementation')
  expect(useStore.getState().implementationComponents).toEqual([{ id: 'c', visible: true }])
  s.clearHighlights()
  expect(useStore.getState().highlighted).toEqual([])
  s.setView('navigation')
  s.select('b')
  s.setView('implementation')
  expect(useStore.getState().highlighted).toEqual(['b'])
  expect(useStore.getState().implementationComponents?.[0]).toEqual({ id: 'c', visible: false })
})
test('workspace round-trip preserves hidden entries, removal, order and visibility', () => {
  const components = [
    { id: 'c', visible: false },
    { id: 'a', visible: true },
  ]
  useStore.getState().setImplementationScope(components)
  const layout = workspaceDocument().projects[0].layout
  expect(restoredLayout(layout).implementationComponents).toEqual(components)
  expect(restoredLayout(layout).highlighted).toEqual(['a'])
  useStore.getState().setImplementationScope([])
  expect(restoredLayout(workspaceDocument().projects[0].layout).implementationComponents).toEqual(
    [],
  )
})
test('legacy layouts retain fallback and malformed entries are ignored', () => {
  expect(restoredLayout({}).closedTaskIds).toEqual([])
  expect(restoredLayout({ closedTaskIds: ['one', null, 4, 'one', 'two'] }).closedTaskIds).toEqual([
    'one',
    'two',
  ])
  expect(restoredLayout({ closedTaskIds: 'one' }).closedTaskIds).toEqual([])
  expect(restoredLayout({ highlighted: ['a'] }).implementationComponents).toBeUndefined()
  expect(
    restoredLayout({
      implementationComponents: [
        null,
        3,
        {},
        { id: 'b', visible: false },
        { id: 'b', visible: true },
      ],
    }).implementationComponents,
  ).toEqual([{ id: 'b', visible: false }])
})
