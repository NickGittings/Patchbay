import type { TerminalSpec } from '../types'

/** The part of a map node these suggestions read. */
interface ComponentLike {
  id: string
  data: { name: string; terminals: TerminalSpec[] }
}

/** A task terminal that looks like a check and could be marked as the component's validator. */
export interface ValidatorSuggestion {
  componentId: string
  componentName: string
  terminalId: string
  terminalName: string
  command: string
}

/** Terminal ids that name check tasks (detection gives `test`). */
const CHECK_IDS = new Set(['test', 'tests', 'check', 'typecheck', 'lint'])
/** Package script and make target names (their first `:._-` segment) that name checks. */
const CHECK_SCRIPTS = new Set(['test', 'tests', 'unit', 'check', 'typecheck', 'types', 'lint'])
/** Script names and subcommands that keep running: `cargo watch`, `vite dev`, `npm start`. */
const SERVES = new Set(['watch', 'dev', 'serve', 'start', 'preview'])
/** Development servers, which serve when run bare too. */
const DEV_SERVERS = new Set(['vite', 'next', 'nuxt', 'nuxi', 'astro', 'nodemon'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

/** Programs that run checks, given their arguments; any arguments when the set is empty. */
const CHECK_PROGRAMS = new Map<string, string[]>([
  ['cargo', ['test', 'nextest', 'check', 'clippy']],
  ['go', ['test', 'vet']],
  ['ruff', ['check']],
  ['biome', ['check', 'lint', 'ci']],
  ['golangci-lint', ['run']],
  ['next', ['lint']],
  ['astro', ['check']],
  ['nuxt', ['typecheck']],
  ['nuxi', ['typecheck']],
  ...[
    'pytest',
    'unittest',
    'jest',
    'mocha',
    'tsc',
    'vue-tsc',
    'mypy',
    'pyright',
    'svelte-check',
    'eslint',
    'oxlint',
    'flake8',
    'pylint',
    'stylelint',
  ].map((p): [string, string[]] => [p, []]),
])

/** A watch flag that isn't turned off (`--watch=false`, `--watchAll=0`). */
const watches = (word: string) => {
  const match = /^(?:-w|--watch[\w-]*)(?:=(.*))?$/.exec(word)
  return !!match && !['false', '0'].includes((match[1] ?? '').toLowerCase())
}

/** A script or target name's first segment, so `test:unit`, `test_unit` and `Test` match. */
const segments = (name: string) => name.toLowerCase().split(/[:._-]/)

export const program = (word: string) => word.replace(/^.*[\\/]/, '').toLowerCase()

/**
 * How one simple command reads, approximately: `check`, `serves` (may never exit) or `other`.
 * Leading `VAR=value` assignments and common wrappers (`env`, `npx`, `pnpm exec`, `uv run`,
 * `python -m`) are skipped.
 */
function readSimple(command: string): 'check' | 'serves' | 'other' {
  let words = command
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^['"]|['"]$/g, ''))
  if (words.some(watches)) return 'serves'
  for (;;) {
    while (/^[A-Za-z_]\w*=/.test(words[0] ?? '')) words = words.slice(1)
    const [first = '', sub = ''] = words
    const name = program(first)
    let skip = 0
    if (['env', 'npx', 'pnpx', 'bunx'].includes(name)) skip = 1
    else if (PACKAGE_MANAGERS.has(name) && ['exec', 'dlx', 'x'].includes(sub)) skip = 2
    else if (['uv', 'poetry', 'pipenv', 'pdm'].includes(name) && sub === 'run') skip = 2
    else if (/^python[0-9.]*$/.test(name) && sub === '-m') skip = 2
    if (!skip) break
    words = words.slice(skip)
    while (words[0]?.startsWith('-')) words = words.slice(1)
  }
  const [first = '', sub = '', third = ''] = words
  const name = program(first)
  if (SERVES.has(sub.toLowerCase())) return 'serves'
  if (DEV_SERVERS.has(name) && (!sub || name === 'nodemon')) return 'serves'
  if (PACKAGE_MANAGERS.has(name) || name === 'make' || name === 'just') {
    const script = PACKAGE_MANAGERS.has(name) && ['run', 'run-script'].includes(sub) ? third : sub
    const parts = segments(script)
    if (parts.some((part) => SERVES.has(part))) return 'serves'
    return CHECK_SCRIPTS.has(parts[0]) ? 'check' : 'other'
  }
  // Vitest watches unless told to run once.
  if (name === 'vitest') return sub === 'run' || words.includes('--run') ? 'check' : 'serves'
  const subs = CHECK_PROGRAMS.get(name)
  return subs && (!subs.length || subs.includes(sub)) ? 'check' : 'other'
}

/**
 * How each simple command of a command line reads, and whether it ends in the background: a
 * lone `&` (not `&&`, `&>` or `>&`).
 */
export function readCommand(command: string) {
  const parts = command.split(/&&|\|\||[;|\n]/).filter((part) => part.trim())
  return { background: /(^|[^&>])&(?![&>])/.test(command), reads: parts.map(readSimple) }
}

/** Readings per terminal object: the map replaces a terminal's object when it changes. */
const readings = new WeakMap<TerminalSpec, boolean>()

/**
 * Whether to suggest a terminal as a validator: an unassigned task whose id or command looks
 * like a check, unless it obviously watches or serves (a watch flag, a dev/serve/start/preview
 * script or subcommand, a backgrounded `&`). This is approximate, so nothing is pre-checked.
 */
function suggestible(t: TerminalSpec): boolean {
  const cached = readings.get(t)
  if (cached !== undefined) return cached
  let result = false
  if (t.kind === 'task' && !t.action && t.command.trim()) {
    const { background, reads } = readCommand(t.command)
    if (!background && !reads.includes('serves'))
      result = CHECK_IDS.has(t.id) || reads.includes('check')
  }
  readings.set(t, result)
  return result
}

/** Whether a component has a terminal marked as Validation. */
export const hasValidator = (c: ComponentLike) =>
  c.data.terminals.some((t) => t.action === 'validation')

/** The key a declined suggestion is remembered by. */
export const validatorKey = (componentId: string, terminalId: string) =>
  JSON.stringify([componentId, terminalId])

/** What the Activity panel offers for setting up validation. */
export interface ValidatorSetup {
  /** Suggestions not declined. */
  suggestions: ValidatorSuggestion[]
  /** Components with neither a validator nor any check terminal, declined or not. */
  missing: ComponentLike[]
  /** How many suggestions are hidden because they were declined. */
  declined: number
}

/**
 * Unassigned check terminals of components without a validator, in one pass. Detectors never
 * assign graph roles, so the user picks the ones that exit. `declined` keys ([`validatorKey`])
 * are left out.
 */
export function validatorSetup(
  components: ComponentLike[],
  declined: string[] = [],
): ValidatorSetup {
  const out: ValidatorSetup = { suggestions: [], missing: [], declined: 0 }
  const skip = new Set(declined)
  for (const c of components) {
    if (hasValidator(c)) continue
    const candidates = c.data.terminals.filter(suggestible)
    if (!candidates.length) out.missing.push(c)
    for (const t of candidates) {
      if (skip.has(validatorKey(c.id, t.id))) out.declined += 1
      else
        out.suggestions.push({
          componentId: c.id,
          componentName: c.data.name,
          terminalId: t.id,
          terminalName: t.name,
          command: t.command,
        })
    }
  }
  return out
}

/** Whether any undeclined suggestion exists; stops at the first. */
export function hasValidatorSuggestions(components: ComponentLike[], declined: string[] = []) {
  const skip = new Set(declined)
  return components.some(
    (c) =>
      !hasValidator(c) &&
      c.data.terminals.some((t) => !skip.has(validatorKey(c.id, t.id)) && suggestible(t)),
  )
}

/** `declined` keys of terminals still on the map, so removed ones don't accumulate. */
export function liveDeclined(components: ComponentLike[], declined: string[]): string[] {
  const live = new Set(
    components.flatMap((c) => c.data.terminals.map((t) => validatorKey(c.id, t.id))),
  )
  return declined.filter((key) => live.has(key))
}
