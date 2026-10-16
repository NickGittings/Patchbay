import { expect, test } from 'vitest'
import type { TerminalSpec } from '../types'
import { componentsWithoutValidator, validatorSuggestions } from './validators'

const terminal = (
  id: string,
  command: string,
  extra: Partial<TerminalSpec> = {},
): TerminalSpec => ({
  id,
  name: id,
  command,
  kind: 'task',
  ...extra,
})
const component = (id: string, terminals: TerminalSpec[]) => ({
  id,
  data: { name: id.toUpperCase(), terminals },
})
const defaults = [
  terminal('shell', '', { kind: 'shell' }),
  terminal('claude', 'claude', { kind: 'agent' }),
]

test('suggests detected test terminals', () => {
  const core = component('core', [...defaults, terminal('test', 'cargo test')])
  const web = component('web', [terminal('unit', 'pnpm run test'), terminal('dev', 'vite')])
  expect(validatorSuggestions([core, web])).toEqual([
    {
      componentId: 'core',
      componentName: 'CORE',
      terminalId: 'test',
      terminalName: 'test',
      command: 'cargo test',
    },
    {
      componentId: 'web',
      componentName: 'WEB',
      terminalId: 'unit',
      terminalName: 'unit',
      command: 'pnpm run test',
    },
  ])
})

test('a component with a validator gets no suggestions', () => {
  const core = component('core', [
    terminal('check', 'cargo clippy', { action: 'validation' }),
    terminal('test', 'cargo test'),
  ])
  expect(validatorSuggestions([core])).toEqual([])
  expect(componentsWithoutValidator([core])).toEqual([])
})

test('skips development, command-less, shell and agent terminals', () => {
  const app = component('app', [
    ...defaults,
    terminal('test', 'npm test', { action: 'development' }),
    terminal('check', ''),
    terminal('pytest', 'pytest', { kind: 'shell' }),
    terminal('dev', 'npm run dev'),
  ])
  expect(validatorSuggestions([app])).toEqual([])
  expect(componentsWithoutValidator([app]).map((c) => c.id)).toEqual(['app'])
})
