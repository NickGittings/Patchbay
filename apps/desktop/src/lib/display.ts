import type { ComponentKind, SessionState, TerminalSpec } from '../types'

export const KIND_COLOR: Record<ComponentKind, string> = {
  frontend: '#4cc2ff',
  backend: '#a78bfa',
  service: '#3ecf8e',
  library: '#8a8f9c',
  database: '#f5a524',
  app: '#ff7ab6',
  other: '#6b7280',
}

export type Health = 'idle' | 'running' | 'ok' | 'fail'

/** Status dot for a terminal: running, last exit result, or never started. */
export function terminalHealth(session: SessionState | undefined): Health {
  if (!session) return 'idle'
  if (session.running) return 'running'
  return session.exitCode === 0 ? 'ok' : 'fail'
}

export function describeTerminal(t: TerminalSpec) {
  if (t.kind === 'shell' && !t.command) return 'interactive shell'
  return t.command
}
