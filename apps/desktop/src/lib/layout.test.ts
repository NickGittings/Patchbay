import { expect, test } from 'vitest'
import type { Component } from '../types'
import { arrange, COLUMN_WIDTH, ROW_HEIGHT } from './layout'

const component = (id: string, x = 0, y = 0): Component => ({
  id,
  name: id,
  kind: 'service',
  path: id,
  notes: '',
  terminals: [],
  position: { x, y },
})
const link = (source: string, target: string) => ({ source, target })

test('dependents sit left of what they depend on', () => {
  const p = arrange(
    [component('c'), component('b'), component('a')],
    [link('a', 'b'), link('b', 'c')],
  )
  expect(p.a.x).toBe(0)
  expect(p.b.x).toBe(COLUMN_WIDTH)
  expect(p.c.x).toBe(2 * COLUMN_WIDTH)
  expect(new Set([p.a.y, p.b.y, p.c.y]).size).toBe(1)
})

test('a cycle still gets a layout', () => {
  const p = arrange([component('a'), component('b')], [link('a', 'b'), link('b', 'a')])
  expect(Object.keys(p).sort()).toEqual(['a', 'b'])
  expect(p.a).not.toEqual(p.b)
})

test('rows follow neighbours, so links stop crossing', () => {
  // a1 → b2 and a2 → b1, listed so that keeping the current order would cross.
  const p = arrange(
    [component('a1', 0, 0), component('a2', 0, 1), component('b1', 1, 0), component('b2', 1, 1)],
    [link('a1', 'b2'), link('a2', 'b1')],
  )
  expect(Math.sign(p.a1.y - p.a2.y)).toBe(Math.sign(p.b2.y - p.b1.y))
})

test('unlinked components go below the graph', () => {
  const p = arrange([component('lone'), component('a'), component('b')], [link('a', 'b')])
  expect(p.lone.y).toBe(ROW_HEIGHT)
  expect(p.a.y).toBe(0)
})

test('keeps the map where it was', () => {
  const p = arrange([component('a', 500, 300), component('b', 900, 700)], [link('a', 'b')])
  expect(p.a).toEqual({ x: 500, y: 300 })
  expect(p.b).toEqual({ x: 500 + COLUMN_WIDTH, y: 300 })
})

test('ignores links to components not on the map', () => {
  const p = arrange([component('a')], [link('a', 'gone')])
  expect(p).toEqual({ a: { x: 0, y: 0 } })
})
