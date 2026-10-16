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

/** A check, with a `caution` when it runs something Patchbay can't see (a script, a target). */
interface Reading {
  kind: CheckKind
  caution?: string
}

/**
 * How one simple command reads: a check; `other`, a known program that isn't a check; `endless`,
 * one that may never exit (watchers, servers, background jobs), which validation would wait on
 * forever; or `unknown`, a program Patchbay can't interpret.
 */
type Part = Reading | 'other' | 'endless' | 'unknown'

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
/** Script names that start long-running processes. */
const SERVE_SCRIPTS = new Set(['dev', 'serve', 'start', 'preview', 'watch'])
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
/** Development servers: everything but `build` keeps running. */
const DEV_SERVERS = new Set(['vite', 'next', 'nuxt', 'astro', 'nodemon'])
/** Shell built-ins and helpers that run no check and always return. */
const NEUTRAL = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'echo', 'printf', 'true', 'tee'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])

/**
 * Whether arguments ask to watch: `true` for `--watch`/`--watchAll` (also `=true`), `false`
 * when they turn it off (`--watch=false`, `=0`), `undefined` without such a flag.
 */
export function watchFlag(args: string[]): boolean | undefined {
  let watching: boolean | undefined
  for (const arg of args) {
    const match = /^--watch(?:all)?(?:=(.*))?$/i.exec(arg)
    if (!match) continue
    if (['false', '0', 'no'].includes((match[1] ?? '').toLowerCase())) watching ??= false
    else return true
  }
  return watching
}

/**
 * A package script or make target by name, matched by whole segments (`test:devices` is a test,
 * `test:watch` and `dev` keep running).
 */
function scriptPart(name: string, ci: boolean, what: string): Part {
  const segments = name.toLowerCase().split(/[:._-]/)
  const [first] = segments
  if (
    segments.includes('watch') ||
    SERVE_SCRIPTS.has(first) ||
    segments[segments.length - 1] === 'dev'
  )
    return 'endless'
  const kind = SCRIPT_KINDS.find(([pattern]) => pattern.test(name))?.[1]
  if (!kind) return first === 'build' ? 'other' : 'unknown'
  return ci
    ? { kind }
    : { kind, caution: `Runs the ${what} “${name}”: make sure it exits rather than watching.` }
}

/** The part a program and its arguments run. */
function programPart(program: string, args: string[], ci: boolean): Part {
  const [sub] = args
  switch (program) {
    case 'cargo':
      if (sub === 'test' || sub === 'nextest') return { kind: 'test' }
      if (sub === 'check') return { kind: 'check' }
      if (sub === 'clippy') return { kind: 'lint' }
      if (sub === 'fmt' && args.includes('--check')) return { kind: 'lint' }
      return sub === 'watch' ? 'endless' : 'other'
    case 'go':
      if (sub === 'test') return { kind: 'test' }
      if (sub === 'vet') return { kind: 'lint' }
      return 'other'
    case 'vitest':
      // Vitest watches in an interactive terminal unless told to run once (or `CI` is set).
      if (sub === 'watch' || sub === 'dev') return 'endless'
      if (sub === 'run' || args.includes('--run') || watchFlag(args) === false || ci)
        return { kind: 'test' }
      return 'endless'
    case 'pytest':
    case 'py.test':
    case 'unittest':
    case 'jest':
    case 'mocha':
    case 'bun-test':
      return { kind: 'test' }
    case 'tsc':
    case 'vue-tsc':
      if (args.includes('-w')) return 'endless'
      return args.includes('--noEmit') ? { kind: 'check' } : 'other'
    case 'mypy':
    case 'pyright':
    case 'svelte-check':
      return { kind: 'check' }
    case 'ruff':
      if (sub === 'check' || (sub === 'format' && args.includes('--check'))) return { kind: 'lint' }
      return 'other'
    case 'biome':
      return sub === 'check' || sub === 'lint' || sub === 'ci' ? { kind: 'lint' } : 'other'
    case 'prettier':
      return args.includes('--check') ? { kind: 'lint' } : 'other'
    case 'golangci-lint':
      return sub === 'run' ? { kind: 'lint' } : 'other'
    case 'eslint':
    case 'oxlint':
    case 'flake8':
    case 'pylint':
    case 'stylelint':
      return { kind: 'lint' }
    case 'make':
    case 'just':
      return sub && !sub.startsWith('-') ? scriptPart(sub, ci, `${program} target`) : 'unknown'
    default:
      if (DEV_SERVERS.has(program)) return sub === 'build' ? 'other' : 'endless'
      return 'unknown'
  }
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
 * `pnpm exec`, `uv run`, `python -m`, `sh -c`, …), package scripts, then the program and its
 * arguments. Arguments are never read as programs; a watch flag anywhere makes it `endless`.
 */
function readSimple(tokens: string[], depth: number): Part[] {
  if (watchFlag(tokens)) return ['endless']
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
    if (!program) return []
    const [, sub] = rest
    if (NEUTRAL.has(program)) return []
    if (program === 'env' || program === 'npx' || program === 'pnpx' || program === 'bunx') {
      rest = skipFlags(rest.slice(1))
    } else if (PACKAGE_MANAGERS.has(program) && ['exec', 'dlx', 'x'].includes(sub)) {
      rest = skipFlags(rest.slice(2))
    } else if (['uv', 'poetry', 'pipenv', 'pdm'].includes(program) && sub === 'run') {
      rest = skipFlags(rest.slice(2))
    } else if (/^python[0-9.]*$/.test(program) && sub === '-m') {
      rest = rest.slice(2)
    } else if (SHELLS.has(program) && /^-[a-z]*c[a-z]*$/.test(sub ?? '')) {
      // `bash -c "<command>"` runs its argument as a command line.
      return rest[2] !== undefined && depth < 3 ? readParts(rest[2], depth + 1) : ['unknown']
    } else if (program === 'bun' && sub === 'test') {
      return [programPart('bun-test', rest.slice(2), ci)]
    } else if (program === 'npm') {
      // `npm` runs only `test` and `start` without `run`; anything else is a built-in.
      if (sub === 'run' || sub === 'run-script') {
        const [script] = skipFlags(rest.slice(2))
        return [script ? scriptPart(script, ci, 'package script') : 'other']
      }
      if (sub === 'test' || sub === 't' || sub === 'tst')
        return [scriptPart('test', ci, 'package script')]
      return [sub === 'start' ? 'endless' : 'other']
    } else if (PACKAGE_MANAGERS.has(program)) {
      // The others run any script that isn't a built-in.
      const [script] = sub === 'run' ? skipFlags(rest.slice(2)) : [sub]
      if (!script || script.startsWith('-')) return ['unknown']
      return [BUILTINS.has(script) ? 'other' : scriptPart(script, ci, 'package script')]
    } else {
      return [programPart(program, rest.slice(1), ci)]
    }
  }
}

/**
 * Splits a command line into simple commands' words, POSIX-style (as core's `command_tokens`
 * reads it on Unix): single and double quotes, backslashes, and the operators `&&`, `||`, `;`,
 * `|`, `&` and newlines. `background` reports a lone `&`; `undefined` means syntax this doesn't
 * follow (subshells, substitutions, an unterminated quote).
 */
export function splitCommand(
  command: string,
): { commands: string[][]; background: boolean } | undefined {
  const commands: string[][] = []
  let words: string[] = []
  let word: string | undefined
  let background = false
  const endWord = () => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]
    const next = command[i + 1]
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      if (end < 0) return undefined
      word = (word ?? '') + command.slice(i + 1, end)
      i = end
    } else if (c === '"') {
      let text = ''
      let j = i + 1
      for (; j < command.length && command[j] !== '"'; j += 1) {
        const d = command[j]
        if (d === '`' || (d === '$' && command[j + 1] === '(')) return undefined
        if (d === '\\' && '"\\$`'.includes(command[j + 1] ?? 'x')) {
          j += 1
          text += command[j]
        } else text += d
      }
      if (j >= command.length) return undefined
      word = (word ?? '') + text
      i = j
    } else if (c === '\\') {
      if (next === undefined) return undefined
      if (next !== '\n') word = (word ?? '') + next
      i += 1
    } else if (c === '\n' || c === ';') {
      endCommand()
    } else if (/\s/.test(c)) {
      endWord()
    } else if (c === '|') {
      if (next === '|' || next === '&') i += 1
      endCommand()
    } else if (c === '&') {
      if (next === '&') {
        i += 1
        endCommand()
      } else if (next === '>' || /[<>]$/.test(word ?? '')) {
        // A redirection: `&>file`, `2>&1`.
        word = (word ?? '') + c
      } else {
        background = true
        endCommand()
      }
    } else if ('()`'.includes(c) || (c === '$' && next === '(')) {
      return undefined
    } else {
      word = (word ?? '') + c
    }
  }
  endCommand()
  return { commands, background }
}

/** Reads every simple command of a command line; `unknown` when it can't be split. */
function readParts(command: string, depth = 0): Part[] {
  const split = splitCommand(command)
  if (!split) return ['unknown']
  // A backgrounded job may never exit.
  if (split.background) return ['endless']
  return split.commands.flatMap((words) => readSimple(words, depth))
}

const ID_CAUTION = 'A custom command: make sure it exits rather than watching.'
const UNKNOWN_CAUTION = 'Also runs commands Patchbay can’t read: make sure they exit.'

/**
 * Reads a terminal: the best check its command runs. Only a command Patchbay can't interpret at
 * all falls back to its id (never checked), not one it reads as something other than a check.
 */
function readTerminal(t: TerminalSpec): Reading | undefined {
  if (t.kind !== 'task' || t.action || !t.command.trim()) return undefined
  const parts = readParts(t.command)
  if (parts.includes('endless')) return undefined
  const checks = parts.filter((p): p is Reading => typeof p === 'object')
  if (checks.length) {
    const best = checks.reduce((best, r) => (RANK[r.kind] > RANK[best.kind] ? r : best))
    const caution =
      checks.find((r) => r.caution)?.caution ??
      (parts.includes('unknown') ? UNKNOWN_CAUTION : undefined)
    return caution ? { kind: best.kind, caution } : best
  }
  const kind = CHECK_IDS[t.id]
  if (!kind || parts.includes('other') || watchFlag(t.command.split(/\s+/))) return undefined
  return { kind, caution: ID_CAUTION }
}

/** Whether a component has a terminal marked as Validation. */
export const hasValidator = (c: ComponentLike) =>
  c.data.terminals.some((t) => t.action === 'validation')

/** The key a declined suggestion is remembered by. */
export const validatorKey = (componentId: string, terminalId: string) =>
  JSON.stringify([componentId, terminalId])

/** What the Activity panel offers for setting up validation. */
export interface ValidatorSetup {
  /** Suggestions not declined, at most one per component `preferred`. */
  suggestions: ValidatorSuggestion[]
  /** Components with neither a validator nor any check terminal, declined or not. */
  missing: ComponentLike[]
  /** How many suggestions are hidden because they were declined. */
  declined: number
}

/**
 * Unassigned check terminals of components without a validator, in one pass, leaving out
 * commands that may never exit, since validation waits for them. Detectors never assign graph
 * roles, so the user confirms these; at most one per component, its best remaining one that
 * surely exits, is `preferred`. `declined` keys ([`validatorKey`]) are left out.
 */
export function validatorSetup(
  components: ComponentLike[],
  declined: string[] = [],
): ValidatorSetup {
  const out: ValidatorSetup = { suggestions: [], missing: [], declined: 0 }
  for (const c of components) {
    if (hasValidator(c)) continue
    const candidates = c.data.terminals.flatMap((t) => {
      const reading = readTerminal(t)
      return reading ? [{ t, reading }] : []
    })
    if (!candidates.length) out.missing.push(c)
    const shown = candidates.filter(({ t }) => !declined.includes(validatorKey(c.id, t.id)))
    out.declined += candidates.length - shown.length
    const best = shown
      .filter(({ reading }) => !reading.caution)
      .reduce<(typeof shown)[number] | undefined>(
        (best, x) => (!best || RANK[x.reading.kind] > RANK[best.reading.kind] ? x : best),
        undefined,
      )
    for (const { t, reading } of shown)
      out.suggestions.push({
        componentId: c.id,
        componentName: c.data.name,
        terminalId: t.id,
        terminalName: t.name,
        command: t.command,
        preferred: best?.t === t,
        ...(reading.caution ? { caution: reading.caution } : {}),
      })
  }
  return out
}

/** Whether any undeclined suggestion exists; stops at the first. */
export const hasValidatorSuggestions = (components: ComponentLike[], declined: string[] = []) =>
  components.some(
    (c) =>
      !hasValidator(c) &&
      c.data.terminals.some(
        (t) => !declined.includes(validatorKey(c.id, t.id)) && readTerminal(t) !== undefined,
      ),
  )

/** `declined` keys of terminals still on the map, so removed ones don't accumulate. */
export function liveDeclined(components: ComponentLike[], declined: string[]): string[] {
  const live = new Set(
    components.flatMap((c) => c.data.terminals.map((t) => validatorKey(c.id, t.id))),
  )
  return declined.filter((key) => live.has(key))
}
