import { expect, test } from 'vitest'
import type { TerminalSpec } from '../types'
import {
  hasValidator,
  hasValidatorSuggestions,
  liveDeclined,
  validatorKey,
  validatorSetup,
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
/** Suggested terminal ids for one component holding `terminals`. */
const suggested = (...terminals: TerminalSpec[]) =>
  validatorSetup([component('c', terminals)]).suggestions.map((s) => s.terminalId)
/** Whether a single `run` terminal with `command` is suggested. */
const suggests = (command: string) => suggested(terminal('run', command)).length > 0

test('suggests check terminals, none of them preferred', () => {
  const core = component('core', [
    terminal('shell', '', { kind: 'shell' }),
    terminal('claude', 'claude', { kind: 'agent' }),
    terminal('test', 'cargo test'),
  ])
  const web = component('web', [terminal('unit', 'vitest run'), terminal('dev', 'vite')])
  expect(validatorSetup([core, web]).suggestions).toEqual([
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
      command: 'vitest run',
    },
  ])
})

test('a component with a validator gets no suggestions', () => {
  const core = component('core', [
    terminal('check', 'cargo clippy', { action: 'validation' }),
    terminal('test', 'cargo test'),
  ])
  expect(hasValidator(core)).toBe(true)
  expect(validatorSetup([core])).toEqual({ suggestions: [], missing: [], declined: 0 })
})

test('skips terminals with a role, no command, or a non-task kind', () => {
  const app = component('app', [
    terminal('test', 'npm test', { action: 'development' }),
    terminal('check', ''),
    terminal('pytest', 'pytest', { kind: 'shell' }),
  ])
  expect(validatorSetup([app]).missing).toEqual([app])
  expect(validatorSetup([app]).suggestions).toEqual([])
})

test('recognises checks by id or by program and script name', () => {
  for (const id of ['test', 'tests', 'check', 'typecheck', 'lint'])
    expect(suggested(terminal(id, './scripts/run.sh')), id).toEqual([id])
  // Own-property-safe: inherited object keys aren't check ids.
  for (const id of ['constructor', '__proto__', 'toString'])
    expect(suggested(terminal(id, './run.sh')), id).toEqual([])
  for (const command of [
    'cargo clippy --all-targets',
    'go vet ./...',
    'RUST_LOG=info cargo test',
    'python -m pytest',
    'uv run pytest -q',
    'npx --yes oxlint src',
    'env CI=1 npm run test',
    'cd web && npm run check',
    'npm test',
    'pnpm test_unit',
    'yarn run test.unit',
    'npm run Test',
    'make lint',
    'next lint',
    'astro check',
    'nuxt typecheck',
  ])
    expect(suggests(command), command).toBe(true)
  for (const command of [
    'echo pytest',
    'cargo run -- test',
    'cargo build',
    'npm ci',
    'npm install jest',
    './build.sh',
  ])
    expect(suggests(command), command).toBe(false)
})

test('never suggests commands that obviously watch or serve', () => {
  for (const command of [
    'vitest',
    'jest --watch',
    'jest --watchAll',
    'jest --watchAll=true',
    'tsc --noEmit -w',
    'npm run test:watch',
    'pnpm test:dev',
    'npm start',
    'pnpm run dev',
    'vite',
    'next',
    'next dev',
    'astro preview',
    'mdbook serve',
    'cargo watch -x test',
    'cargo test & cargo clippy',
  ])
    expect(suggests(command), command).toBe(false)
  // Even under a check id.
  expect(suggested(terminal('test', 'npm run dev'))).toEqual([])
  expect(suggested(terminal('test', 'vite --port 3000'))).toEqual([])
  // Watching turned off, and redirections, still run once.
  for (const command of ['jest --watchAll=false', 'vitest --run --watch=0', 'cargo test 2>&1'])
    expect(suggests(command), command).toBe(true)
})

test('readings are cached per terminal object', () => {
  const t = terminal('run', 'cargo test')
  const c = component('c', [t])
  expect(hasValidatorSuggestions([c])).toBe(true)
  // A mutated object keeps its reading; the map replaces objects on edit.
  t.command = 'vite'
  expect(hasValidatorSuggestions([c])).toBe(true)
  expect(hasValidatorSuggestions([component('c', [{ ...t }])])).toBe(false)
})

test('declined suggestions are left out and counted', () => {
  const core = component('core', [terminal('test', 'cargo test'), terminal('lint', 'cargo clippy')])
  const docs = component('docs', [terminal('serve', 'mdbook serve')])
  const declined = [validatorKey('core', 'test')]
  const setup = validatorSetup([core, docs], declined)
  expect(setup.suggestions.map((s) => s.terminalId)).toEqual(['lint'])
  expect(setup.declined).toBe(1)
  expect(setup.missing).toEqual([docs])
  expect(hasValidatorSuggestions([core, docs], declined)).toBe(true)
  expect(hasValidatorSuggestions([core], [...declined, validatorKey('core', 'lint')])).toBe(false)
  expect(hasValidatorSuggestions([docs])).toBe(false)
})

test('declined keys of removed terminals are pruned', () => {
  const core = component('core', [terminal('test', 'cargo test')])
  const keys = [validatorKey('core', 'test'), validatorKey('core', 'gone'), '["old"]']
  expect(liveDeclined([core], keys)).toEqual([validatorKey('core', 'test')])
})
