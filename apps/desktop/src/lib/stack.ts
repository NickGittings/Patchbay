import type { TerminalSpec } from '../types'
import { program, readCommand, validatorKey } from './validators'

/** The part of a map node these suggestions read. */
interface ComponentLike {
  id: string
  data: { name: string; terminals: TerminalSpec[] }
}

/** A task terminal that looks like a dev server or watcher and could join a stack. */
export interface DevelopmentSuggestion {
  componentId: string
  componentName: string
  terminalId: string
  terminalName: string
  command: string
  /** Text the server prints once it is up, for known servers; empty starts it without waiting. */
  readyWhen: string
}

/** Terminal ids detection gives long-running tasks. */
const SERVE_IDS = new Set(['dev', 'serve', 'start', 'watch'])

/**
 * What known servers print when they are ready (matched case-insensitively), by program, or by
 * program and subcommand.
 */
const READY_TEXT = new Map<string, string>([
  ['vite', 'ready in'],
  ['astro', 'ready in'],
  ['next', 'ready'],
  ['uvicorn', 'application startup complete'],
  ['fastapi', 'application startup complete'],
  ['flask', 'running on'],
  ['manage.py runserver', 'starting development server'],
  ['rails server', 'listening on'],
  ['rails s', 'listening on'],
  ['puma', 'listening on'],
  ['webpack serve', 'compiled'],
  ['webpack-dev-server', 'compiled'],
])

/** The ready text of the first known server the command runs, else empty. */
export function readyTextFor(command: string): string {
  const words = command
    .trim()
    .split(/\s+/)
    .map((w) => program(w.replace(/^['"]|['"]$/g, '')))
  for (const [i, word] of words.entries()) {
    const text = READY_TEXT.get(`${word} ${words[i + 1] ?? ''}`) ?? READY_TEXT.get(word)
    if (text) return text
  }
  return ''
}

/** Readings per terminal object: the map replaces a terminal's object when it changes. */
const readings = new WeakMap<TerminalSpec, boolean>()

/**
 * Whether to suggest a terminal for Development: an unassigned task that serves or watches (a
 * dev/serve/start/watch id, script or subcommand, a dev server, a watch flag), unless it ends in
 * the background or is a check.
 */
function suggestible(t: TerminalSpec): boolean {
  const cached = readings.get(t)
  if (cached !== undefined) return cached
  let result = false
  if (t.kind === 'task' && !t.action && t.command.trim()) {
    const { background, reads } = readCommand(t.command)
    result =
      !background && !reads.includes('check') && (reads.includes('serves') || SERVE_IDS.has(t.id))
  }
  readings.set(t, result)
  return result
}

/** Whether a component has a terminal marked as Development. */
export const hasDevelopment = (c: ComponentLike) =>
  c.data.terminals.some((t) => t.action === 'development')

/** What the Stack panel offers for setting up a stack. */
export interface StackSetup {
  /** Suggestions not declined, one component's after another. */
  suggestions: DevelopmentSuggestion[]
  /** Components with a Development terminal already, which a new stack includes. */
  ready: string[]
  /** How many suggestions are hidden because they were declined. */
  declined: number
}

/**
 * Unassigned dev-server terminals of components without a Development terminal. `declined` keys
 * (`validatorKey`) are left out.
 */
export function stackSetup(components: ComponentLike[], declined: string[] = []): StackSetup {
  const out: StackSetup = { suggestions: [], ready: [], declined: 0 }
  const skip = new Set(declined)
  for (const c of components) {
    if (hasDevelopment(c)) {
      out.ready.push(c.id)
      continue
    }
    for (const t of c.data.terminals.filter(suggestible)) {
      if (skip.has(validatorKey(c.id, t.id))) out.declined += 1
      else
        out.suggestions.push({
          componentId: c.id,
          componentName: c.data.name,
          terminalId: t.id,
          terminalName: t.name,
          command: t.command,
          readyWhen: t.readyWhen?.trim() || readyTextFor(t.command),
        })
    }
  }
  return out
}

/** Whether any member depends on another, so starting dependencies first matters. */
export const linkedWithin = (ids: string[], edges: { source: string; target: string }[]) => {
  const members = new Set(ids)
  return edges.some((e) => e.source !== e.target && members.has(e.source) && members.has(e.target))
}
