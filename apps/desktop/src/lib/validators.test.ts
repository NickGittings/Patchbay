import { expect, test } from 'vitest'
import type { TerminalSpec } from '../types'
import {
  componentsWithoutValidator,
  hasValidator,
  validatorKey,
  validatorSuggestions,
} from './validators'

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
/** Suggested terminal ids for one component holding `terminals`. */
const suggested = (...terminals: TerminalSpec[]) =>
  validatorSuggestions([component('c', terminals)]).map((s) => s.terminalId)
/** Whether a single `run` terminal with `command` is suggested. */
const suggests = (command: string) => suggested(terminal('run', command)).length > 0

test('suggests detected test terminals', () => {
  const core = component('core', [...defaults, terminal('test', 'cargo test')])
  const web = component('web', [terminal('unit', 'vitest run'), terminal('dev', 'vite')])
  expect(validatorSuggestions([core, web])).toEqual([
    {
      componentId: 'core',
      componentName: 'CORE',
      terminalId: 'test',
      terminalName: 'test',
      command: 'cargo test',
      preferred: true,
    },
    {
      componentId: 'web',
      componentName: 'WEB',
      terminalId: 'unit',
      terminalName: 'unit',
      command: 'vitest run',
      preferred: true,
    },
  ])
})

test('a component with a validator gets no suggestions', () => {
  const core = component('core', [
    terminal('check', 'cargo clippy', { action: 'validation' }),
    terminal('test', 'cargo test'),
  ])
  expect(hasValidator(core)).toBe(true)
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

test('leaves out test runners that watch for changes', () => {
  for (const command of [
    'vitest',
    'npx vitest',
    'vitest watch',
    'pnpm exec vitest --reporter dot',
    'jest --watch',
    'jest --watchAll',
    'tsc --noEmit --watch',
    'tsc --noEmit -w',
    'npm run test:watch',
    'cargo watch -x test',
  ])
    expect(suggests(command), command).toBe(false)
  for (const command of ['vitest run', 'vitest --run', 'CI=1 vitest', 'jest', 'jest --ci'])
    expect(suggests(command), command).toBe(true)
  // An id alone doesn't make a watching command a check.
  expect(suggested(terminal('test', 'vitest'))).toEqual([])
})

test('recognises common checks by program, not by arguments', () => {
  for (const command of [
    'cargo check',
    'cargo clippy --all-targets',
    'cargo nextest run',
    'cargo fmt --check',
    'go test ./...',
    'go vet ./...',
    'python -m pytest',
    'uv run pytest -q',
    'python3 -m unittest',
    'tsc --noEmit',
    'npx tsc --noEmit',
    'ruff check .',
    'mypy src',
    'eslint .',
    'npx --yes oxlint src',
    'bun test',
    'npm run lint',
    'pnpm lint',
    'yarn typecheck',
    'npm test',
    'RUST_LOG=info cargo test',
    'env CI=1 npm run test',
    'cd web && npm run check',
  ])
    expect(suggests(command), command).toBe(true)
  for (const command of [
    'node server.js --reporter jest',
    'echo pytest',
    'cargo run -- test',
    'tsc -b',
    'ruff format .',
    'npm ci',
    'npm install jest',
    'pnpm add -D vitest',
    'vite',
  ])
    expect(suggests(command), command).toBe(false)
  expect(suggested(terminal('lint', './scripts/lint.sh'))).toEqual(['lint'])
})

test('package scripts and custom commands are offered unchecked with a caution', () => {
  const [script, custom, ci] = validatorSuggestions([
    component('web', [terminal('test', 'npm run test')]),
    component('api', [terminal('check', './check.sh')]),
    component('ui', [terminal('test', 'CI=true pnpm run test')]),
  ])
  expect(script).toMatchObject({ terminalId: 'test', preferred: false })
  expect(script.caution).toContain('“test”')
  expect(custom).toMatchObject({ terminalId: 'check', preferred: false })
  expect(custom.caution).toBeTruthy()
  // With `CI` set, test runners run once.
  expect(ci.preferred).toBe(true)
  expect(ci.caution).toBeUndefined()
})

test('prefers at most one check per component', () => {
  const web = component('web', [
    terminal('lint', 'eslint .'),
    terminal('test', 'vitest run'),
    terminal('check', 'tsc --noEmit'),
    terminal('script', 'npm run check'),
  ])
  const list = validatorSuggestions([web])
  expect(list.map((s) => s.terminalId)).toEqual(['lint', 'test', 'check', 'script'])
  expect(list.filter((s) => s.preferred).map((s) => s.terminalId)).toEqual(['test'])
  // The first of equally good checks wins.
  const rust = component('rust', [terminal('a', 'cargo test'), terminal('b', 'cargo nextest run')])
  expect(
    validatorSuggestions([rust])
      .filter((s) => s.preferred)
      .map((s) => s.terminalId),
  ).toEqual(['a'])
})

test('declined suggestions and hints are left out', () => {
  const core = component('core', [terminal('test', 'cargo test'), terminal('lint', 'cargo clippy')])
  const docs = component('docs', [terminal('serve', 'mdbook serve')])
  const declined = [validatorKey('core', 'test'), validatorKey('docs')]
  expect(validatorSuggestions([core, docs], declined).map((s) => s.terminalId)).toEqual(['lint'])
  expect(componentsWithoutValidator([core, docs])).toEqual([docs])
  expect(componentsWithoutValidator([core, docs], declined)).toEqual([])
  // Keys of a component and of its terminals never collide.
  expect(validatorKey('core')).not.toBe(validatorKey('core', ''))
})
