import { expect, test } from 'vitest'
import {
  changePosition,
  changeRefs,
  resolveChangeSelection,
  stepChange,
  stepKey,
} from './changeNav'

const refs = changeRefs([
  { id: 'a', files: [{ path: 'a/1.ts' }, { path: 'a/2.ts' }] },
  { id: 'b', files: [{ path: 'b/1.ts' }] },
])

test('a finding selected during reload resolves when changed files arrive and keeps its line', () => {
  const selection = { componentId: '@project', path: '/repo/src/app.txt', line: 4 }
  expect(resolveChangeSelection([], selection, '/repo')).toEqual(selection)
  const loaded = [{ componentId: 'app', path: 'src/app.txt' }]
  const selected = resolveChangeSelection(loaded, selection, '/repo')
  expect(selected).toEqual({ ...loaded[0], line: 4 })
  expect(changePosition(loaded, selected)).toBe(0)
  expect(resolveChangeSelection(loaded, null)).toBeNull()
  expect(resolveChangeSelection(loaded, undefined)).toBeUndefined()
})

test('an explicit component stays selected when changed paths are shared', () => {
  const loaded = [
    { componentId: 'first', path: 'shared.txt' },
    { componentId: 'second', path: 'shared.txt' },
  ]
  const selected = resolveChangeSelection(loaded, { ...loaded[1], line: 1 })
  expect(selected).toEqual({ ...loaded[1], line: 1 })
  expect(changePosition(loaded, selected)).toBe(1)
  expect(stepChange(loaded, selected, -1)).toEqual(loaded[0])
})

test('stepping crosses component lists and stops at either end', () => {
  expect(stepChange(refs, refs[1], 1)).toEqual({ componentId: 'b', path: 'b/1.ts' })
  expect(stepChange(refs, refs[2], -1)).toEqual({ componentId: 'a', path: 'a/2.ts' })
  expect(stepChange(refs, refs[2], 1)).toBeUndefined()
  expect(stepChange(refs, refs[0], -1)).toBeUndefined()
  expect(changePosition(refs, refs[2])).toBe(2)
})

test('an unlisted file steps to the first going forward and the last going back', () => {
  const gone = { componentId: 'a', path: 'gone.ts' }
  expect(changePosition(refs, gone)).toBe(-1)
  expect(stepChange(refs, gone, 1)).toEqual(refs[0])
  expect(stepChange(refs, null, -1)).toEqual(refs[2])
  expect(stepChange([], null, 1)).toBeUndefined()
})

test('lists step with all four arrows, diffs only with left and right', () => {
  const key = (k: string, extra: object = {}) => ({
    key: k,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: null,
    ...extra,
  })
  expect(stepKey(key('ArrowDown'), 'list')).toBe(1)
  expect(stepKey(key('ArrowUp'), 'list')).toBe(-1)
  expect(stepKey(key('ArrowDown'), 'diff')).toBe(0)
  expect(stepKey(key('ArrowRight'), 'diff')).toBe(1)
  expect(stepKey(key('ArrowLeft'), 'diff')).toBe(-1)
  expect(stepKey(key('ArrowRight', { metaKey: true }), 'diff')).toBe(0)
  expect(stepKey(key('ArrowDown', { target: { tagName: 'INPUT' } }), 'list')).toBe(0)
  expect(stepKey(key('j'), 'list')).toBe(0)
})

test.each([
  ['ArrowUp', -1],
  ['ArrowDown', 1],
  ['ArrowLeft', -1],
  ['ArrowRight', 1],
])('body %s steps without taking modified or field keys', (key, delta) => {
  const event = {
    key: String(key),
    target: { tagName: 'BODY' } as unknown as EventTarget,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  }
  expect(stepKey(event, 'list')).toBe(delta)
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'])
    expect(stepKey({ ...event, [modifier]: true }, 'list')).toBe(0)
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT'])
    expect(stepKey({ ...event, target: { tagName } as unknown as EventTarget }, 'list')).toBe(0)
})
