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

test('in Files mode an agent the query names takes Enter, ahead of files', () => {
  const named = { title: 'Builder', group: 'Agents', preferred: true }
  const elsewhere = { title: 'Planner', group: 'Agents', preferred: false }
  expect(defaultSelection([elsewhere, named, file('builder.ts')], 'Files', 'builder')).toBe(1)
  // Matching only the agent's project, worktree or branch leaves Enter on the file.
  expect(defaultSelection([elsewhere, file('app.ts')], 'Files', 'app')).toBe(1)
  expect(defaultSelection([named, component('Builder')], 'Files', 'builder')).toBe(1)
  expect(defaultSelection([command('Build'), named], 'Commands', 'build')).toBe(0)
})

test('agents take Enter once the priority group is known to be empty', () => {
  const agent = { title: 'Builder', group: 'Agents' }
  expect(defaultSelection([agent], 'Files', 'branch')).toBe(0)
  expect(defaultSelection([agent, component('Web')], 'Commands', 'we')).toBe(0)
  // Files still loading could replace it, so Enter waits.
  expect(defaultSelection([agent], 'Files', 'branch', true)).toBe(-1)
  expect(defaultSelection([agent, file('a.ts')], 'Files', 'a')).toBe(1)
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
