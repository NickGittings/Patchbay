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

/** Terminal ids detection gives check tasks. */
const CHECK_IDS = new Set(['test', 'check'])
/** Commands detection generates for tests, plus common equivalents. */
const CHECK_COMMAND =
  /(^|[\s/])(cargo (test|nextest|clippy)|go (test|vet)|pytest|vitest|jest|(npm|pnpm|yarn|bun)( run)? (test|check))\b/

const hasValidator = (c: ComponentLike) => c.data.terminals.some((t) => t.action === 'validation')

const looksLikeCheck = (t: TerminalSpec) =>
  t.kind === 'task' &&
  !t.action &&
  !!t.command.trim() &&
  (CHECK_IDS.has(t.id) || CHECK_COMMAND.test(t.command))

/**
 * Unassigned check terminals of components without a validator. Detectors never assign graph
 * roles, so the user confirms these; a component that already has a validator gets none.
 */
export function validatorSuggestions(components: ComponentLike[]): ValidatorSuggestion[] {
  return components
    .filter((c) => !hasValidator(c))
    .flatMap((c) =>
      c.data.terminals.filter(looksLikeCheck).map((t) => ({
        componentId: c.id,
        componentName: c.data.name,
        terminalId: t.id,
        terminalName: t.name,
        command: t.command,
      })),
    )
}

/** Components with neither a validator nor a terminal to suggest as one. */
export function componentsWithoutValidator(components: ComponentLike[]): ComponentLike[] {
  return components.filter((c) => !hasValidator(c) && !c.data.terminals.some(looksLikeCheck))
}
