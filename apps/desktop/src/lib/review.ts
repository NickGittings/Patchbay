import { sessionId, type ChangedFile, type SessionState, type TerminalSpec } from '../types'

/** Whether a task terminal's last run covers the current changes. */
export type ValidationState = 'running' | 'passed' | 'failed' | 'stale' | 'notRun'

export interface Validation {
  terminal: TerminalSpec
  state: ValidationState
  session?: SessionState
}

/**
 * When the newest changed file was modified, or `undefined` when nothing has a time (no changes,
 * or only deletions: a deleted file leaves no modification time, so those can't make runs stale).
 */
export function latestChange(files: ChangedFile[] | undefined): number | undefined {
  let latest: number | undefined
  for (const f of files ?? []) {
    if (f.modifiedMs !== undefined && (latest === undefined || f.modifiedMs > latest))
      latest = f.modifiedMs
  }
  return latest
}

/** The newest change among several components, for something that depends on all of them. */
export function latestChangeOf(
  changes: Record<string, ChangedFile[]>,
  ids: string[],
): number | undefined {
  let latest: number | undefined
  for (const id of ids) {
    const t = latestChange(changes[id])
    if (t !== undefined && (latest === undefined || t > latest)) latest = t
  }
  return latest
}

/**
 * The status of each task terminal of a component. A finished run counts only if it started
 * after `changedAt`; one that started earlier (or saw edits while it ran) is stale.
 */
export function validations(
  componentId: string,
  terminals: TerminalSpec[],
  sessions: Record<string, SessionState>,
  changedAt: number | undefined,
): Validation[] {
  return terminals
    .filter((t) => t.kind === 'task')
    .map((terminal) => {
      const session = sessions[sessionId(componentId, terminal.id)]
      let state: ValidationState
      if (!session || (!session.running && session.exitCode === undefined)) state = 'notRun'
      else if (session.running) state = 'running'
      else if (changedAt !== undefined && (session.startedMs ?? 0) < changedAt) state = 'stale'
      else state = session.exitCode === 0 ? 'passed' : 'failed'
      return { terminal, state, session }
    })
}

/** "3m ago" style age of a Unix millisecond time. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** `path` (relative to the project root) as shown inside the component at `base`. */
export function pathWithin(path: string, base: string): string {
  if (base === '.' || base === '') return path
  const prefix = base.endsWith('/') ? base : `${base}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}
