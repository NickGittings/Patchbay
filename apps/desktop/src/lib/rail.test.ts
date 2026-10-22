import { beforeEach, expect, test, vi } from 'vitest'
import { create } from 'zustand'
import type { View } from '../types'

vi.mock('../store', () => ({
  useStore: create(() => ({
    project: { id: 'one' },
    activeTask: null as string | null,
    simpleMode: false,
    view: 'plan',
    sessionsPanelOpen: false,
    activityPanelOpen: false,
    autoPanelRequest: 0,
    setView: (view: View) => store.setState({ view }),
  })),
}))
const { useStore: store } = await import('../store')
const { selectPanel, togglePanel, selectRailView, selectedRailView, useRail, panelWidth } =
  await import('./rail')
const { useSimpleUi } = await import('./simpleUi')
beforeEach(() => {
  store.setState({
    project: { id: 'one' } as never,
    activeTask: null,
    simpleMode: false,
    view: 'plan',
    sessionsPanelOpen: false,
    activityPanelOpen: false,
    autoPanelRequest: 0,
  })
  useRail.setState({ panel: null })
  useSimpleUi.setState({ worktrees: {} })
})
test('utility selection is exclusive, toggles closed, and accepts legacy requests', () => {
  selectPanel('sessions')
  expect(store.getState().sessionsPanelOpen).toBe(true)
  selectPanel('activity')
  expect(store.getState().sessionsPanelOpen).toBe(false)
  expect(store.getState().activityPanelOpen).toBe(true)
  togglePanel('activity')
  expect(useRail.getState().panel).toBeNull()
  store.setState({ sessionsPanelOpen: true })
  expect(useRail.getState().panel).toBe('sessions')
  store.setState({ autoPanelRequest: 1 })
  expect(useRail.getState().panel).toBe('auto')
  expect(store.getState().sessionsPanelOpen).toBe(false)
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
