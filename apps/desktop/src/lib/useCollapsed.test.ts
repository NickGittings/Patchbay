import { beforeEach, expect, test, vi } from 'vitest'
import type { GroupImperativeHandle, PanelImperativeHandle } from 'react-resizable-panels'

const store = vi.hoisted(() => ({
  panels: {} as Record<string, Record<string, number>>,
  setPanelLayout: vi.fn((id: string, layout: Record<string, number>) => {
    store.panels[id] = layout
  }),
}))
vi.mock('../store', () => ({ useStore: { getState: () => store } }))
const { closePanel, openPanel, shouldOpenPanel } = await import('./useCollapsed')
import {
  CHAT_PANEL,
  CHAT_OPEN_SIZES,
  CHAT_DEFAULT_SIZE,
  CHAT_MIN_SIZE,
  CANVAS_PANEL,
} from './panelLayout'

beforeEach(() => {
  store.panels = {}
  vi.clearAllMocks()
})

function panel(size: number): PanelImperativeHandle {
  return {
    isCollapsed: () => size === 0,
    getSize: () => ({ asPercentage: size, inPixels: size * 10 }),
    collapse: vi.fn(),
    expand: vi.fn(),
    resize: vi.fn(),
  }
}

test('closing remembers the dragged width and fills the canvas without resizing Inspector', () => {
  store.panels['App-simple-open'] = { 'App-pane-5': 24 }
  const p = panel(42)
  const group: GroupImperativeHandle = {
    getLayout: () => ({ 'App-pane-2': 34, 'App-simple-chat': 42, 'App-pane-5': 24 }),
    setLayout: vi.fn(),
  }
  // The mocked panel never reports collapsing, so the hide is reported as not taking effect.
  expect(closePanel(p, 'App-simple-chat', 'App-simple-open', group, 'App-pane-2')).toBe(false)
  expect(store.panels['App-simple-open']).toEqual({ 'App-simple-chat': 42, 'App-pane-5': 24 })
  expect(group.setLayout).toHaveBeenCalledWith({
    'App-pane-2': 76,
    'App-simple-chat': 0,
    'App-pane-5': 24,
  })
  expect(p.collapse).not.toHaveBeenCalled()
})

test('closing an already hidden chat preserves its remembered width', () => {
  store.panels['App-simple-open'] = { 'App-simple-chat': 42 }
  const p = panel(0)
  expect(closePanel(p, 'App-simple-chat', 'App-simple-open')).toBe(true)
  expect(store.setPanelLayout).not.toHaveBeenCalled()
  expect(p.collapse).not.toHaveBeenCalled()
})

test('closing falls back to the panel when its fill layout is unavailable', () => {
  for (const group of [undefined, { getLayout: () => ({}), setLayout: vi.fn() }]) {
    const p = panel(42)
    closePanel(p, 'App-simple-chat', 'App-simple-open', group, 'App-pane-2')
    expect(p.collapse).toHaveBeenCalledOnce()
    expect(store.panels['App-simple-open']).toEqual({ 'App-simple-chat': 42 })
    if (group) expect(group.setLayout).not.toHaveBeenCalled()
  }
})

test('keepCollapsed preserves restored and user-hidden panels through measurement', () => {
  const current = { shown: true, reveal: null }
  expect(shouldOpenPanel(current, undefined, true)).toBe(false)
  expect(shouldOpenPanel(current, current, true)).toBe(false)
})

test('keepCollapsed opens only for an explicit reveal, including on mount', () => {
  const current = { shown: true, reveal: { sid: 'session' } }
  expect(shouldOpenPanel(current, undefined, true)).toBe(true)
  expect(shouldOpenPanel({ shown: true, reveal: null }, { shown: false, reveal: null }, true)).toBe(
    false,
  )
  expect(shouldOpenPanel(current, { shown: true, reveal: { sid: 'session' } }, true)).toBe(true)
  expect(shouldOpenPanel(current, { shown: true, reveal: undefined }, true)).toBe(true)
})

test('hidden panels never open and keepCollapsed responds to option changes', () => {
  expect(shouldOpenPanel({ shown: false, reveal: 'new' }, undefined, false)).toBe(false)
  expect(
    shouldOpenPanel({ shown: false, reveal: 'new' }, { shown: true, reveal: 'old' }, true),
  ).toBe(false)
  const current = { shown: true, reveal: undefined }
  expect(shouldOpenPanel(current, undefined, false)).toBe(true)
  expect(shouldOpenPanel(current, current, false)).toBe(true)
})

test('revealing uses the live layout even when the worktree has no saved Chat layout', () => {
  store.panels[CHAT_OPEN_SIZES] = { [CHAT_PANEL]: 42 }
  const p = panel(0)
  const group = {
    getLayout: () => ({ [CANVAS_PANEL]: 76, [CHAT_PANEL]: 0, 'App-pane-5': 24 }),
    setLayout: vi.fn(),
  }
  openPanel(p, CHAT_PANEL, CHAT_OPEN_SIZES, group, CANVAS_PANEL, CHAT_DEFAULT_SIZE, CHAT_MIN_SIZE)
  expect(group.setLayout).toHaveBeenCalledWith({
    [CANVAS_PANEL]: 34,
    [CHAT_PANEL]: 42,
    'App-pane-5': 24,
  })
  expect(p.expand).not.toHaveBeenCalled()
})

test('opening delegates to the panel constraints when the canvas is narrower than the minimum', () => {
  const p = panel(0)
  const group = {
    getLayout: () => ({ [CANVAS_PANEL]: 12, [CHAT_PANEL]: 0, 'App-pane-5': 88 }),
    setLayout: vi.fn(),
  }
  openPanel(p, CHAT_PANEL, CHAT_OPEN_SIZES, group, CANVAS_PANEL, CHAT_DEFAULT_SIZE, CHAT_MIN_SIZE)
  expect(group.setLayout).not.toHaveBeenCalled()
  expect(p.expand).toHaveBeenCalledOnce()
  expect(p.resize).toHaveBeenCalledWith('35%')
})
