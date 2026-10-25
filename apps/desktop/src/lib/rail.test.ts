import { beforeEach, expect, test, vi } from 'vitest'
import { create } from 'zustand'
import type { View } from '../types'

vi.mock('../store', () => ({
  useStore: create(() => ({
    project: { id: 'one' },
    activeTask: null as string | null,
    simpleMode: false,
    view: 'plan',
    utilityPanel: null,
    setView: (view: View) => store.setState({ view }),
    setSimpleMode: (simpleMode: boolean) => store.setState({ simpleMode }),
  })),
}))
const { useStore: store } = await import('../store')
const {
  selectPanel,
  togglePanel,
  closePanel,
  selectRailView,
  selectRailShortcut,
  selectedRailView,
  useRail,
  panelWidth,
} = await import('./rail')
const { useSimpleUi, simpleKey } = await import('./simpleUi')
beforeEach(() => {
  store.setState({
    project: { id: 'one' } as never,
    activeTask: null,
    simpleMode: false,
    view: 'plan',
    utilityPanel: null,
  })
  useRail.setState({ settings: null })
  useSimpleUi.setState({ worktrees: {} })
})
test('utility selection is exclusive, toggles closed, and closes only the named panel', () => {
  const panel = () => store.getState().utilityPanel
  selectPanel('sessions')
  expect(panel()).toBe('sessions')
  selectPanel('activity')
  expect(panel()).toBe('activity')
  togglePanel('activity')
  expect(panel()).toBeNull()
  selectPanel('auto')
  closePanel('sessions')
  expect(panel()).toBe('auto')
  closePanel('auto')
  expect(panel()).toBeNull()
})
test('chat filters and full workspace selection restore independently per worktree', () => {
  store.setState({ simpleMode: true })
  selectRailView('review')
  expect(selectedRailView()).toBe('review')
  expect(store.getState().view).toBe('plan')
  store.setState({ activeTask: 'feature' })
  expect(selectedRailView()).toBe('navigation')
  selectRailView('implementation')
  expect(selectedRailView()).toBe('implementation')
  store.setState({ simpleMode: false })
  expect(selectedRailView()).toBe('plan')
  selectRailView('review')
  store.setState({ simpleMode: true })
  expect(selectedRailView()).toBe('implementation')
  store.setState({ activeTask: null })
  expect(selectedRailView()).toBe('review')
})
test('panel widths leave room for the workspace at the minimum window width', () => {
  expect(panelWidth(360, 1440)).toBe(360)
  expect(panelWidth(1000, 1440)).toBe(640)
  expect(panelWidth(1000, 900)).toBe(440)
  expect(panelWidth(50, 900)).toBe(240)
})
test('Chat view selection filters stages while keeping Chat and the last Full view', () => {
  store.setState({ simpleMode: true, view: 'review' })
  for (const view of ['plan', 'implementation', 'review'] as const) {
    selectRailView(view)
    expect(store.getState().simpleMode).toBe(true)
    expect(store.getState().view).toBe('review')
    expect(selectedRailView()).toBe(view)
  }
  selectRailView('navigation')
  expect(store.getState().simpleMode).toBe(true)
  expect(store.getState().view).toBe('review')
  expect(selectedRailView()).toBe('navigation')
  expect(useSimpleUi.getState().worktrees[simpleKey('one', null)].stageFilter).toBe('all')
})
test('Full view selection switches views and leaves stage filters alone', () => {
  for (const view of ['navigation', 'plan', 'implementation', 'review'] as const) {
    selectRailView(view)
    expect(store.getState().view).toBe(view)
    expect(store.getState().simpleMode).toBe(false)
    expect(selectedRailView()).toBe(view)
  }
  expect(useSimpleUi.getState().worktrees).toEqual({})
})
test('numbered Chat shortcuts restore the last Full view without changing stage filters', () => {
  for (const view of ['plan', 'implementation', 'review'] as const) {
    store.setState({ simpleMode: true, view: 'review' })
    selectRailView('plan')
    selectRailShortcut(view)
    expect(store.getState().simpleMode).toBe(false)
    expect(store.getState().view).toBe('review')
    store.setState({ simpleMode: true })
    expect(selectedRailView()).toBe('plan')
  }
  selectRailShortcut('navigation')
  expect(store.getState().simpleMode).toBe(true)
  expect(selectedRailView()).toBe('navigation')
  store.setState({ simpleMode: false })
  for (const view of ['navigation', 'plan', 'implementation', 'review'] as const) {
    selectRailShortcut(view)
    expect(store.getState().view).toBe(view)
  }
})
test('Merge remains a distinct Chat filter from Review', () => {
  store.setState({ simpleMode: true })
  useSimpleUi.getState().patch(simpleKey('one', null), { stageFilter: 'merge' })
  expect(selectedRailView()).toBeNull()
  selectRailView('review')
  expect(useSimpleUi.getState().worktrees[simpleKey('one', null)].stageFilter).toBe('review')
})
test('project role settings close when switching or closing projects', () => {
  useRail.setState({ settings: 'roles' })
  store.setState({ project: { id: 'two' } as never })
  expect(useRail.getState().settings).toBeNull()
  useRail.setState({ settings: 'roles' })
  store.setState({ project: null })
  expect(useRail.getState().settings).toBeNull()
  store.setState({ project: { id: 'one' } as never })
  expect(useRail.getState().settings).toBeNull()
  useRail.setState({ settings: 'notifications' })
  store.setState({ project: null })
  expect(useRail.getState().settings).toBe('notifications')
})
