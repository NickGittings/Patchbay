import { expect, test } from 'vitest'
import type { TerminalSpec } from '../types'
import { linkedWithin, readyTextFor, stackSetup } from './stack'
import { validatorKey } from './validators'

const terminal = (
  id: string,
  command: string,
  extra: Partial<TerminalSpec> = {},
): TerminalSpec => ({ id, name: id, command, kind: 'task', ...extra })
const component = (id: string, terminals: TerminalSpec[]) => ({
  id,
  data: { name: id.toUpperCase(), terminals },
})
const suggests = (command: string, id = 'run') =>
  stackSetup([component('c', [terminal(id, command)])]).suggestions.length > 0

test('dev servers, watchers and serve scripts are suggested; checks and one-shot tasks are not', () => {
  for (const command of [
    'npm run dev',
    'pnpm start',
    'vite',
    'next dev',
    'cargo watch -x run',
    'tsc --watch',
    'vitest',
  ])
    expect(suggests(command), command).toBe(true)
  for (const command of ['npm test', 'cargo build', 'vitest run', 'npm run dev &', 'make'])
    expect(suggests(command), command).toBe(false)
  expect(suggests('uvicorn app:main --reload', 'dev')).toBe(true)
  expect(suggests('cargo run', 'build')).toBe(false)
})

test('known servers get the text they print once ready; others start without waiting', () => {
  expect(readyTextFor('npx vite --port 5173')).toBe('ready in')
  expect(readyTextFor('next dev')).toBe('ready')
  expect(readyTextFor('uv run uvicorn app:main')).toBe('application startup complete')
  expect(readyTextFor('python manage.py runserver')).toBe('starting development server')
  expect(readyTextFor('bin/rails server')).toBe('listening on')
  expect(readyTextFor('npm run dev')).toBe('')
  const own = stackSetup([component('c', [terminal('dev', 'vite', { readyWhen: 'UP' })])])
  expect(own.suggestions[0].readyWhen).toBe('UP')
})

test('components with a Development terminal are ready members, and declines are hidden', () => {
  const setup = stackSetup(
    [
      component('api', [terminal('dev', 'cargo watch -x run', { action: 'development' })]),
      component('web', [terminal('dev', 'vite'), terminal('test', 'vitest run')]),
      component('docs', [terminal('dev', 'astro dev')]),
    ],
    [validatorKey('docs', 'dev')],
  )
  expect(setup.ready).toEqual(['api'])
  expect(setup.suggestions.map((s) => `${s.componentId}:${s.terminalId}`)).toEqual(['web:dev'])
  expect(setup.declined).toBe(1)
})

test('ordering matters only when members depend on each other', () => {
  const edges = [{ source: 'web', target: 'api' }]
  expect(linkedWithin(['web', 'api'], edges)).toBe(true)
  expect(linkedWithin(['web', 'docs'], edges)).toBe(false)
})
