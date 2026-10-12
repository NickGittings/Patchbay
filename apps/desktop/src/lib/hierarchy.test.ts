import { expect, test } from 'vitest'
import { matchesComponent } from './hierarchy'

const node = {
  data: {
    name: 'Web UI',
    path: 'apps/frontend',
    kind: 'library' as const,
    notes: '',
    terminals: [],
  },
}

test('empty and whitespace queries include every component', () => {
  expect(matchesComponent(node, '')).toBe(true)
  expect(matchesComponent(node, '  ')).toBe(true)
})

test('matches name, path and kind without case sensitivity', () => {
  expect(matchesComponent(node, 'WEB')).toBe(true)
  expect(matchesComponent(node, ' FRONTEND ')).toBe(true)
  expect(matchesComponent(node, 'LIBRARY')).toBe(true)
})

test('unmatched queries exclude the component', () => {
  expect(matchesComponent(node, 'backend')).toBe(false)
  expect(matchesComponent(node, 'service')).toBe(false)
})
