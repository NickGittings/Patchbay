import type { ComponentKind, SessionState, TerminalKind, TerminalSpec } from '../types'
import { ago } from './review'

export const KIND_COLOR: Record<ComponentKind, string> = {
  frontend: '#38bdf8',
  backend: '#a78bfa',
  service: '#34d399',
  library: '#a1a1aa',
  database: '#fbbf24',
  app: '#f472b6',
  other: '#71717a',
}

export type Health =
  | 'idle'
  | 'running'
  | 'ok'
  | 'fail'
  | 'working'
  | 'waiting'
  | 'input'
  | 'review'
  | 'ready'
  | 'unhealthy'

/** How much a status asks for the user: 0 for nothing, higher first. */
export type Attention = 0 | 1 | 2 | 3 | 4

export interface TerminalStatus {
  health: Health
  label: string
  /** Longer explanation for a tooltip. */
  detail?: string
  url?: string
  attention: Attention
  /**
   * When the result or failure that asks for attention happened (Unix ms), until a window has
   * shown the session; showing it then calls `terminal_seen`.
   */
  unseenSince?: number
}

/** "3m" style duration since a Unix millisecond time. */
const age = (ms: number, now: number) => ago(ms, now).replace(/ ago$/, '')

const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' — ')

/** A status's label and detail (and any further lines) as one tooltip. */
export const statusTitle = (status: TerminalStatus, ...extra: (string | undefined)[]) =>
  join(status.label, status.detail, ...extra)

/**
 * What a terminal is doing: not started, stopped or exited; for agents working, needing input,
 * or done and ready for review; for services ready or not responding. A finished review or a
 * failure stops asking for attention once a window has shown the session (`status.seenMs`).
 */
export function terminalStatus(
  kind: TerminalKind,
  session: SessionState | undefined,
  now = Date.now(),
): TerminalStatus {
  if (!session) return { health: 'idle', label: 'Not started', attention: 0 }
  if (session.disconnected) return { health: 'idle', label: 'Disconnected', attention: 0 }
  if (session.interrupted) return { health: 'fail', label: 'Interrupted', attention: 1 }
  const seenMs = session.status?.seenMs ?? 0
  if (!session.running) {
    const when = session.exitedMs ? ago(session.exitedMs, now) : undefined
    if (session.exitCode === 0)
      return { health: 'ok', label: 'Exited', detail: join('Exited 0', when), attention: 0 }
    if (session.status?.stopped)
      return { health: 'idle', label: 'Stopped', detail: join('Stopped', when), attention: 0 }
    const unseen = kind !== 'shell' && seenMs < (session.exitedMs ?? 0)
    return {
      health: 'fail',
      label: 'Failed',
      detail: join(`Exited ${session.exitCode ?? '?'}`, when),
      attention: unseen ? 3 : 0,
      unseenSince: unseen ? session.exitedMs : undefined,
    }
  }
  const status = session.status
  const agent = status?.agent
  if (agent) {
    const since = `for ${age(agent.sinceMs, now)}`
    switch (agent.state) {
      case 'ended':
        return {
          health: 'idle',
          label: 'Ended',
          detail: 'Provider conversation ended',
          attention: 0,
        }
      case 'idle':
        return {
          health: 'waiting',
          label: 'Idle',
          detail: join('Waiting for a prompt', since),
          attention: 0,
        }
      case 'needsInput':
        return {
          health: 'input',
          label: 'Needs input',
          detail: join(agent.message ?? 'Waiting for your answer', since),
          attention: 4,
          unseenSince: seenMs < agent.sinceMs ? agent.sinceMs : undefined,
        }
      case 'working':
        return {
          health: 'working',
          label: 'Working',
          detail: join(agent.prompt, since),
          attention: 0,
        }
      case 'review':
        if (seenMs < agent.sinceMs)
          return {
            health: 'review',
            label: 'Ready for review',
            detail: join(agent.prompt && `Finished: ${agent.prompt}`, ago(agent.sinceMs, now)),
            attention: 2,
            unseenSince: agent.sinceMs,
          }
        break
    }
    return {
      health: 'waiting',
      label: 'Waiting',
      detail: join('Waiting for a prompt', since),
      attention: 0,
    }
  }
  if (kind === 'agent') {
    // No reports (e.g. not Claude Code): judge by output alone.
    return status?.active
      ? { health: 'working', label: 'Active', detail: 'Producing output', attention: 0 }
      : {
          health: 'waiting',
          label: 'Quiet',
          detail: status?.lastOutputMs
            ? `No output for ${age(status.lastOutputMs, now)}`
            : undefined,
          attention: 0,
        }
  }
  const url = status?.url ?? undefined
  if (status?.healthy === false)
    return {
      health: 'unhealthy',
      label: 'Not responding',
      detail: join(url && `${url} refuses connections`, 'the process is still running'),
      url,
      attention: 3,
    }
  if (status?.ready)
    return {
      health: 'ready',
      label: 'Ready',
      detail: url ? `Listening on ${url}` : 'Printed its ready text',
      url,
      attention: 0,
    }
  return {
    health: 'running',
    label: kind === 'shell' ? 'Open' : 'Running',
    detail: kind === 'task' && status?.active ? 'Producing output' : undefined,
    attention: 0,
  }
}

export function describeTerminal(t: TerminalSpec) {
  if (t.kind === 'shell' && !t.command) return 'interactive shell'
  return t.command
}

/**
 * Identifies one run of a session, for dismissals that last a run. A restarted service seeds its
 * generations from the records it kept, so one can repeat; the run's start time tells them apart.
 */
export const sessionRun = (sid: string, session?: Pick<SessionState, 'generation' | 'startedMs'>) =>
  `${sid}:${session?.generation ?? 'unknown'}:${session?.startedMs ?? 'unknown'}`
