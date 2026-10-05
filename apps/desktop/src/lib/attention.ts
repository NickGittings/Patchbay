import { useStore } from '../store'
import {
  PLAN_SCOPE,
  sessionId,
  sessionMetadata,
  type SessionState,
  type TerminalSpec,
} from '../types'
import { terminalStatus, type TerminalStatus } from './display'
import { planTerminals } from './plan'

export interface AttentionItem {
  sid: string
  componentId: string
  /** Component name, or "Planner". */
  owner: string
  terminal: TerminalSpec
  status: TerminalStatus
  /** When the session reached this state, for ordering; Unix ms. */
  sinceMs: number
}

type Snapshot = Pick<
  ReturnType<typeof useStore.getState>,
  'nodes' | 'sessions' | 'runtimeTerminals' | 'devices'
>

function since(session: SessionState | undefined) {
  return session?.status?.agent?.sinceMs ?? session?.exitedMs ?? session?.startedMs ?? 0
}

/** Every terminal that wants the user, most urgent first, oldest first within a level. */
export function attentionItems(s: Snapshot, now = Date.now()): AttentionItem[] {
  const terminals: Omit<AttentionItem, 'status' | 'sinceMs'>[] = [
    ...s.nodes.flatMap((n) =>
      n.data.terminals.map((terminal) => ({
        sid: sessionId(n.id, terminal.id),
        componentId: n.id,
        owner: n.data.name,
        terminal,
      })),
    ),
    ...Object.entries(s.runtimeTerminals)
      .filter(([, r]) => r.projectId === useStore.getState().project?.id)
      .filter(
        ([sid, r]) =>
          !s.nodes
            .find((n) => n.id === r.componentId)
            ?.data.terminals.some((t) => sessionId(r.componentId, t.id) === sid),
      )
      .map(([sid, r]) => ({
        sid,
        componentId: r.componentId,
        owner: s.nodes.find((n) => n.id === r.componentId)?.data.name ?? r.componentId,
        terminal: r.terminal,
      })),
    ...planTerminals(s.devices).map((terminal) => ({
      sid: sessionId(PLAN_SCOPE, terminal.id),
      componentId: PLAN_SCOPE,
      owner: 'Planner',
      terminal,
    })),
  ]
  return terminals
    .map((t) => {
      const session = s.sessions[t.sid]
      return {
        ...t,
        status: terminalStatus(t.terminal.kind, session, now),
        sinceMs: since(session),
      }
    })
    .filter((item) => item.status.attention > 0)
    .sort((a, b) => b.status.attention - a.status.attention || a.sinceMs - b.sinceMs)
}

/** A component's terminals by session id: its own, then those its extensions started. */
export function componentTerminals(
  componentId: string,
  terminals: TerminalSpec[],
  runtimeTerminals: Snapshot['runtimeTerminals'],
): [string, TerminalSpec][] {
  return [
    ...terminals.map((t): [string, TerminalSpec] => [sessionId(componentId, t.id), t]),
    ...Object.entries(runtimeTerminals)
      .filter(([, r]) => r.projectId === useStore.getState().project?.id)
      .filter(([, r]) => r.componentId === componentId)
      .filter(([sid]) => !terminals.some((t) => sessionId(componentId, t.id) === sid))
      .map(([sid, r]): [string, TerminalSpec] => [sid, r.terminal]),
  ]
}

/** The most urgent status among a component's terminals, if any wants the user. */
export function componentAttention(
  componentId: string,
  terminals: TerminalSpec[],
  sessions: Record<string, SessionState>,
  runtimeTerminals: Snapshot['runtimeTerminals'],
): TerminalStatus | null {
  return mostUrgent(
    componentTerminals(componentId, terminals, runtimeTerminals).map(([sid, t]) =>
      terminalStatus(t.kind, sessions[sid]),
    ),
  )
}

/** The status that most wants the user, if any does. */
export function mostUrgent(statuses: TerminalStatus[]): TerminalStatus | null {
  let top: TerminalStatus | null = null
  for (const status of statuses) if (status.attention > (top?.attention ?? 0)) top = status
  return top
}

/**
 * Show a terminal: its tab in the planner, its tile in Implementation, or (for terminals an
 * extension started, which aren't tiled) its tab in the Navigation dock.
 */
export function revealTerminal(item: Pick<AttentionItem, 'sid' | 'componentId'>) {
  const s = useStore.getState()
  if (item.componentId === PLAN_SCOPE) {
    const terminalId = sessionMetadata.get(item.sid)?.terminalId
    if (!terminalId) return
    s.setPlanActive(terminalId)
    s.setView('plan')
    return
  }
  s.select(item.componentId)
  s.setActiveSession(item.sid)
  s.setView(s.runtimeTerminals[item.sid] ? 'navigation' : 'implementation')
}
