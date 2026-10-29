import { expect, test } from 'vitest'
import { CANVAS_MIN_SIZE, collapsedInto, expandedFrom } from './panelLayout'

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

test('expansion uses only the canvas width above its minimum and accounts for the panel size', () => {
  const layout = { 'App-pane-2': 35, 'App-simple-chat': 10, 'App-pane-5': 55 }
  expect(expandedFrom(layout, 'App-simple-chat', 'App-pane-2', 20)).toEqual({
    'App-pane-2': 25,
    'App-simple-chat': 20,
    'App-pane-5': 55,
  })
  // The canvas keeps its minimum rather than going to 0.
  expect(expandedFrom(layout, 'App-simple-chat', 'App-pane-2', 40)).toEqual({
    'App-pane-2': CANVAS_MIN_SIZE,
    'App-simple-chat': 45 - CANVAS_MIN_SIZE,
    'App-pane-5': 55,
  })
  expect(expandedFrom(layout, 'App-simple-chat', 'App-pane-2', 5)).toEqual(layout)
  // The chat could reach its minimum only by taking the canvas below its own: no layout.
  expect(
    expandedFrom(
      { ...layout, 'App-simple-chat': 0, 'App-pane-5': 65 },
      'App-simple-chat',
      'App-pane-2',
      35,
      20,
    ),
  ).toBeUndefined()
})

test('expansion needs both panel ids in the layout', () => {
  const layout = { 'App-pane-2': 100 }
  expect(expandedFrom(layout, 'App-simple-chat', 'App-pane-2', 35)).toBeUndefined()
  expect(expandedFrom(layout, 'App-pane-2', 'missing', 35)).toBeUndefined()
})

test('opening clamps remembered sizes to the minimum and rejects an insufficient fill panel', () => {
  const layout = { canvas: 76, chat: 0, inspector: 24 }
  expect(expandedFrom(layout, 'chat', 'canvas', 12, 20)).toEqual({
    canvas: 56,
    chat: 20,
    inspector: 24,
  })
  expect(
    expandedFrom({ canvas: 12, chat: 0, inspector: 88 }, 'chat', 'canvas', 35, 20),
  ).toBeUndefined()
})
