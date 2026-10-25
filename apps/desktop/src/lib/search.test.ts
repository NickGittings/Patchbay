import { expect, test } from 'vitest'
import { defaultSelection } from './search'

const file = (title: string) => ({ title, group: 'Files' })
const component = (title: string) => ({ title, group: 'Components' })
const command = (title: string) => ({ title, group: 'Commands' })

test('a component named exactly what was typed wins over files and commands', () => {
  const items = [file('web.ts'), component('API'), component('Web'), command('Open web')]
  expect(defaultSelection(items, 'Files', ' web ')).toBe(2)
  expect(defaultSelection(items, 'Commands', 'WEB')).toBe(2)
})

test('otherwise the first of the priority group, never another group', () => {
  const items = [file('web.ts'), component('Website'), command('Open web')]
  expect(defaultSelection(items, 'Files', 'web')).toBe(0)
  expect(defaultSelection(items, 'Commands', 'web')).toBe(2)
  // Files still loading: Enter waits for them rather than running a component, which the files
  // would then replace.
  expect(defaultSelection([component('Website'), command('Open web')], 'Files', 'web')).toBe(-1)
  expect(defaultSelection([component('Website')], 'Components', 'web')).toBe(0)
  expect(defaultSelection([command('Open web')], 'Files', 'web')).toBe(-1)
  expect(defaultSelection([], 'Files', '')).toBe(-1)
})
