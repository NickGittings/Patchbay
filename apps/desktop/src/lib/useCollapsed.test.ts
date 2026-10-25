import { expect, test, vi } from 'vitest'

vi.mock('../store', () => ({ useStore: { getState: () => ({}) } }))
const { collapsedInto, expandedFrom } = await import('./useCollapsed')

test('collapsing chat gives its width to the canvas and leaves the inspector unchanged', () => {
  const layout = { 'App-pane-2': 49, 'App-simple-chat': 35, 'App-pane-5': 16 }
  const next = collapsedInto(layout, 'App-simple-chat', 'App-pane-2')!
  expect(next).toEqual({ 'App-pane-2': 84, 'App-simple-chat': 0, 'App-pane-5': 16 })
  expect(Object.values(next).reduce((sum, size) => sum + size, 0)).toBe(
    Object.values(layout).reduce((sum, size) => sum + size, 0),
  )
  expect(layout).toEqual({ 'App-pane-2': 49, 'App-simple-chat': 35, 'App-pane-5': 16 })
})

test('collapsing the inspector leaves an open or hidden chat at its current size', () => {
  for (const chat of [0, 35]) {
    const layout = { 'App-pane-2': 76 - chat, 'App-simple-chat': chat, 'App-pane-5': 24 }
    expect(collapsedInto(layout, 'App-pane-5', 'App-pane-2')).toEqual({
      'App-pane-2': 100 - chat,
      'App-simple-chat': chat,
      'App-pane-5': 0,
    })
  }
})

test('an already collapsed panel leaves all sizes unchanged', () => {
  const layout = { 'App-pane-2': 100, 'App-simple-chat': 0, 'App-pane-5': 0 }
  expect(collapsedInto(layout, 'App-simple-chat', 'App-pane-2')).toEqual(layout)
})

test('missing source or fill panels cannot produce a layout', () => {
  const layout = { 'App-pane-2': 100 }
  expect(collapsedInto(layout, 'App-simple-chat', 'App-pane-2')).toBeUndefined()
  expect(collapsedInto(layout, 'App-pane-2', 'missing')).toBeUndefined()
  expect(collapsedInto({}, 'App-simple-chat', 'App-pane-2')).toBeUndefined()
})

test('opening chat takes its requested width from the canvas and keeps the inspector hidden', () => {
  const layout = { 'App-pane-2': 100, 'App-simple-chat': 0, 'App-pane-5': 0 }
  expect(expandedFrom(layout, 'App-simple-chat', 'App-pane-2', 35)).toEqual({
    'App-pane-2': 65,
    'App-simple-chat': 35,
    'App-pane-5': 0,
  })
  expect(layout).toEqual({ 'App-pane-2': 100, 'App-simple-chat': 0, 'App-pane-5': 0 })
})

test('opening the inspector preserves the chat width and total size', () => {
  const layout = { 'App-pane-2': 65, 'App-simple-chat': 35, 'App-pane-5': 0 }
  const next = expandedFrom(layout, 'App-pane-5', 'App-pane-2', 24)!
  expect(next).toEqual({ 'App-pane-2': 41, 'App-simple-chat': 35, 'App-pane-5': 24 })
  expect(Object.values(next).reduce((sum, size) => sum + size, 0)).toBe(100)
})

test('expansion uses only the available canvas width and accounts for the panel current size', () => {
  const layout = { 'App-pane-2': 25, 'App-simple-chat': 10, 'App-pane-5': 65 }
  expect(expandedFrom(layout, 'App-simple-chat', 'App-pane-2', 30)).toEqual({
    'App-pane-2': 5,
    'App-simple-chat': 30,
    'App-pane-5': 65,
  })
  expect(expandedFrom(layout, 'App-simple-chat', 'App-pane-2', 40)).toEqual({
    'App-pane-2': 0,
    'App-simple-chat': 35,
    'App-pane-5': 65,
  })
  expect(expandedFrom(layout, 'App-simple-chat', 'App-pane-2', 5)).toEqual(layout)
})

test('expansion needs both panel ids in the layout', () => {
  const layout = { 'App-pane-2': 100 }
  expect(expandedFrom(layout, 'App-simple-chat', 'App-pane-2', 35)).toBeUndefined()
  expect(expandedFrom(layout, 'App-pane-2', 'missing', 35)).toBeUndefined()
})
