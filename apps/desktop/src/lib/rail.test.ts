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
const { useSimpleUi } = await import('./simpleUi')
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
test('panel widths leave room for the workspace at the minimum window width', () => {
  expect(panelWidth(360, 1440)).toBe(360)
  expect(panelWidth(1000, 1440)).toBe(640)
  expect(panelWidth(1000, 900)).toBe(440)
  expect(panelWidth(50, 900)).toBe(240)
})
test('rail buttons and numbered shortcuts leave Chat for the requested Full view', () => {
  for (const select of [selectRailView, selectRailShortcut]) {
    for (const view of ['navigation', 'plan', 'implementation', 'review'] as const) {
      store.setState({ simpleMode: true, view: 'navigation' })
      select(view)
      expect(store.getState()).toMatchObject({ simpleMode: false, view })
      expect(selectedRailView()).toBe(view)
    }
  }
  store.setState({ simpleMode: true })
  selectRailView('navigation')
  expect(store.getState().simpleMode).toBe(false)
  expect(selectedRailView()).toBe('navigation')
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
