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
  /** Offered checked: the component's best candidate whose command surely exits. */
  preferred: boolean
  /** Why the command might not exit, which keeps it unchecked. */
  caution?: string
}

/** What kind of check a command runs, best first. */
type CheckKind = 'test' | 'check' | 'lint'
const RANK: Record<CheckKind, number> = { test: 3, check: 2, lint: 1 }

/**
 * A command's reading: `watch` when it never exits (validation waits for exit), `caution` when it
 * runs something Patchbay can't see, such as a package script or a make target.
 */
interface Reading {
  kind: CheckKind
  watch?: boolean
  caution?: string
}

/** Terminal ids that name check tasks (detection gives `test`). */
const CHECK_IDS: Record<string, CheckKind> = {
  test: 'test',
  tests: 'test',
  check: 'check',
  typecheck: 'check',
  lint: 'lint',
}
/** Package script and make target names that name checks, with an optional `:unit` suffix. */
const SCRIPT_KINDS: [RegExp, CheckKind][] = [
  [/^(test|tests|unit)([:-]|$)/, 'test'],
  [/^(check|typecheck|type-check|types|verify|validate|ci)([:-]|$)/, 'check'],
  [/^lint([:-]|$)/, 'lint'],
]
const WATCH_FLAG = /^--watch(all)?(=|$)/i
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
/** Built-in subcommands of `pnpm`/`yarn`/`bun` that aren't script shorthands. */
const BUILTINS = new Set([
  'add',
  'install',
  'i',
  'remove',
  'update',
  'upgrade',
  'dlx',
  'exec',
  'x',
  'create',
  'init',
  'link',
  'publish',
  'ci',
])

const hasWatchFlag = (args: string[]) => args.some((a) => WATCH_FLAG.test(a))

function scriptReading(name: string, ci: boolean, what: string): Reading | undefined {
  const kind = SCRIPT_KINDS.find(([pattern]) => pattern.test(name))?.[1]
  if (!kind) return undefined
  if (/watch|dev/.test(name)) return { kind, watch: true }
  return ci
    ? { kind }
    : { kind, caution: `Runs the ${what} “${name}”: make sure it exits rather than watching.` }
}

/** The check a program and its arguments run, if any. */
function programReading(program: string, args: string[], ci: boolean): Reading | undefined {
  const [sub] = args
  const reading = ((): Reading | undefined => {
    switch (program) {
      case 'cargo':
        if (sub === 'test' || sub === 'nextest') return { kind: 'test' }
        if (sub === 'check') return { kind: 'check' }
        if (sub === 'clippy') return { kind: 'lint' }
        if (sub === 'fmt' && args.includes('--check')) return { kind: 'lint' }
        return undefined
      case 'go':
        if (sub === 'test') return { kind: 'test' }
        if (sub === 'vet') return { kind: 'lint' }
        return undefined
      case 'vitest':
        // Vitest watches in an interactive terminal unless told to run once (or `CI` is set).
        if (sub === 'run' || args.includes('--run')) return { kind: 'test' }
        return { kind: 'test', watch: !ci || sub === 'watch' || sub === 'dev' }
      case 'pytest':
      case 'py.test':
      case 'unittest':
      case 'jest':
      case 'mocha':
      case 'bun-test':
        return { kind: 'test' }
      case 'tsc':
      case 'vue-tsc':
        if (args.includes('-w')) return { kind: 'check', watch: true }
        return args.includes('--noEmit') ? { kind: 'check' } : undefined
      case 'mypy':
      case 'pyright':
      case 'svelte-check':
        return { kind: 'check' }
      case 'ruff':
        if (sub === 'check' || (sub === 'format' && args.includes('--check')))
          return { kind: 'lint' }
        return undefined
      case 'biome':
        return sub === 'check' || sub === 'lint' || sub === 'ci' ? { kind: 'lint' } : undefined
      case 'prettier':
        return args.includes('--check') ? { kind: 'lint' } : undefined
      case 'golangci-lint':
        return sub === 'run' ? { kind: 'lint' } : undefined
      case 'eslint':
      case 'oxlint':
      case 'flake8':
      case 'pylint':
      case 'stylelint':
        return { kind: 'lint' }
      case 'make':
      case 'just':
        return sub ? scriptReading(sub, ci, `${program} target`) : undefined
      default:
        return undefined
    }
  })()
  return reading && hasWatchFlag(args) ? { ...reading, watch: true } : reading
}

const basename = (token: string) =>
  token
    .replace(/^.*[\\/]/, '')
    .replace(/\.(cmd|exe|bat)$/i, '')
    .toLowerCase()

/** Skips option tokens, as wrappers like `npx --yes vitest` take them before the program. */
const skipFlags = (tokens: string[]) => {
  let i = 0
  while (i < tokens.length && tokens[i].startsWith('-')) i += 1
  return tokens.slice(i)
}

/**
 * Reads one simple command: leading `VAR=value` assignments and `env`, wrappers (`npx`,
 * `pnpm exec`, `uv run`, `python -m`, …), package scripts, then the program and its arguments.
 * Arguments are never read as programs.
 */
function readSimple(tokens: string[]): Reading | undefined {
  let rest = tokens
  let ci = false
  for (;;) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(rest[0] ?? '')
    if (assignment) {
      if (assignment[1] === 'CI' && !['', '0', 'false'].includes(assignment[2])) ci = true
      rest = rest.slice(1)
      continue
    }
    const program = basename(rest[0] ?? '')
    if (!program) return undefined
    const [, sub] = rest
    if (program === 'env' || program === 'npx' || program === 'pnpx' || program === 'bunx') {
      rest = skipFlags(rest.slice(1))
    } else if (PACKAGE_MANAGERS.has(program) && ['exec', 'dlx', 'x'].includes(sub)) {
      rest = skipFlags(rest.slice(2))
    } else if (['uv', 'poetry', 'pipenv', 'pdm'].includes(program) && sub === 'run') {
      rest = skipFlags(rest.slice(2))
    } else if (/^python[0-9.]*$/.test(program) && sub === '-m') {
      rest = rest.slice(2)
    } else if (program === 'bun' && sub === 'test') {
      return programReading('bun-test', rest.slice(2), ci)
    } else if (PACKAGE_MANAGERS.has(program)) {
      // `npm` runs only `test` without `run`; the others run any script that isn't a built-in.
      const [script] =
        sub === 'run' || sub === 'run-script'
          ? skipFlags(rest.slice(2))
          : sub === 't' || sub === 'tst'
            ? ['test']
            : sub &&
                (program === 'npm' ? sub === 'test' : !sub.startsWith('-') && !BUILTINS.has(sub))
              ? [sub]
              : []
      return script ? scriptReading(script, ci, 'package script') : undefined
    } else {
      return programReading(program, rest.slice(1), ci)
    }
  }
}

/** Splits a command into simple commands at `&&`, `||`, `;` and `|`, and those into words. */
function simpleCommands(command: string): string[][] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((part) =>
      part
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word.replace(/^(['"])(.*)\1$/, '$2')),
    )
    .filter((words) => words.length)
}

/** Reads a terminal: the best check its command runs, else one its id names. */
function readTerminal(t: TerminalSpec): Reading | undefined {
  if (t.kind !== 'task' || t.action || !t.command.trim()) return undefined
  const readings = simpleCommands(t.command).flatMap((words) => readSimple(words) ?? [])
  if (readings.some((r) => r.watch)) return undefined
  if (readings.length) {
    const best = readings.reduce((best, r) => (RANK[r.kind] > RANK[best.kind] ? r : best))
    const caution = readings.find((r) => r.caution)?.caution
    return caution ? { kind: best.kind, caution } : best
  }
  const kind = CHECK_IDS[t.id]
  if (!kind || hasWatchFlag(t.command.split(/\s+/))) return undefined
  return { kind, caution: 'A custom command: make sure it exits rather than watching.' }
}

/** Whether a component has a terminal marked as Validation. */
export const hasValidator = (c: ComponentLike) =>
  c.data.terminals.some((t) => t.action === 'validation')

/** The key a declined suggestion is remembered by; without a terminal, a component's hint. */
export const validatorKey = (componentId: string, terminalId?: string) =>
  JSON.stringify(terminalId === undefined ? [componentId] : [componentId, terminalId])

/**
 * Unassigned check terminals of components without a validator, leaving out commands that watch
 * for changes, since validation waits for them to exit. Detectors never assign graph roles, so
 * the user confirms these; at most one per component, its best one that surely exits, is
 * `preferred`. `declined` keys ([`validatorKey`]) are left out.
 */
export function validatorSuggestions(
  components: ComponentLike[],
  declined: string[] = [],
): ValidatorSuggestion[] {
  return components
    .filter((c) => !hasValidator(c))
    .flatMap((c) => {
      const candidates = c.data.terminals.flatMap((t) => {
        const reading = readTerminal(t)
        return reading ? [{ t, reading }] : []
      })
      const best = candidates
        .filter(({ reading }) => !reading.caution)
        .reduce<(typeof candidates)[number] | undefined>(
          (best, x) => (!best || RANK[x.reading.kind] > RANK[best.reading.kind] ? x : best),
          undefined,
        )
      return candidates
        .filter(({ t }) => !declined.includes(validatorKey(c.id, t.id)))
        .map(({ t, reading }) => ({
          componentId: c.id,
          componentName: c.data.name,
          terminalId: t.id,
          terminalName: t.name,
          command: t.command,
          preferred: best?.t === t,
          ...(reading.caution ? { caution: reading.caution } : {}),
        }))
    })
}

/** Components with neither a validator nor a terminal to suggest, except `declined` ones. */
export function componentsWithoutValidator(
  components: ComponentLike[],
  declined: string[] = [],
): ComponentLike[] {
  return components.filter(
    (c) =>
      !hasValidator(c) &&
      !c.data.terminals.some((t) => readTerminal(t)) &&
      !declined.includes(validatorKey(c.id)),
  )
}
