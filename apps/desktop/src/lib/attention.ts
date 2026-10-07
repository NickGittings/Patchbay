import { useStore } from '../store'
import {
  PLAN_SCOPE,
  TASK_ROOT_SCOPE,
  parseSessionId,
  sessionId,
  sessionTask,
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
  /** The task the session runs for; `null` for the open worktree. */
  task: string | null
  /** The task's title, when there is one. */
  taskTitle?: string
  terminal: TerminalSpec
  status: TerminalStatus
  /** When the session reached this state, for ordering; Unix ms. */
  sinceMs: number
}

type Snapshot = Pick<
  ReturnType<typeof useStore.getState>,
  'nodes' | 'sessions' | 'runtimeTerminals' | 'devices' | 'tasks'
> &
  Partial<
    Pick<ReturnType<typeof useStore.getState>, 'rootTerminals' | 'taskWorkspaces' | 'activeTask'>
  >

function since(session: SessionState | undefined) {
  return session?.status?.agent?.sinceMs ?? session?.exitedMs ?? session?.startedMs ?? 0
}

/**
 * Every terminal that wants the user, in the open worktree and in every task, most urgent first,
 * oldest first within a level.
 */
export function attentionItems(s: Snapshot, now = Date.now()): AttentionItem[] {
  const scopes: [string | null, string | undefined][] = [
    [null, undefined],
    ...(s.tasks ?? []).map((t): [string, string] => [t.id, t.title]),
  ]
  const terminals: Omit<AttentionItem, 'status' | 'sinceMs'>[] = [
    ...scopes.flatMap(([task, taskTitle]) => [
      ...s.nodes.flatMap((n) =>
        n.data.terminals.map((terminal) => ({
          sid: sessionId(n.id, terminal.id, task),
          componentId: n.id,
          owner: n.data.name,
          task,
          taskTitle,
          terminal,
        })),
      ),
      ...(task === s.activeTask
        ? (s.rootTerminals ?? [])
        : (s.taskWorkspaces?.[task ?? '']?.rootTerminals ?? [])
      ).map((terminal) => ({
        sid: sessionId(TASK_ROOT_SCOPE, terminal.id, task),
        componentId: TASK_ROOT_SCOPE,
        owner: 'Task root',
        task,
        taskTitle,
        terminal,
      })),
      ...planTerminals(s.devices).map((terminal) => ({
        sid: sessionId(PLAN_SCOPE, terminal.id, task),
        componentId: PLAN_SCOPE,
        owner: 'Planner',
        task,
        taskTitle,
        terminal,
      })),
    ]),
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
        owner:
          s.nodes.find((n) => n.id === r.componentId)?.data.name ??
          (r.componentId === TASK_ROOT_SCOPE ? 'Task root' : r.componentId),
        task: r.taskId ?? sessionTask(sid),
        taskTitle: s.tasks.find((t) => t.id === (r.taskId ?? sessionTask(sid)))?.title,
        terminal: r.terminal,
      })),
  ]
  return terminals
    .filter((t, index) => terminals.findIndex((other) => other.sid === t.sid) === index)
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

/**
 * How many terminals want the user per task (`''` for the open worktree), as a string so a store
 * selector only re-renders when a count changes.
 */
export function attentionCounts(s: Snapshot): string {
  const counts: Record<string, number> = {}
  for (const item of attentionItems(s)) {
    const key = item.task ?? ''
    counts[key] = (counts[key] ?? 0) + 1
  }
  return JSON.stringify(counts)
}

/**
 * A component's terminals by session id: its own (in `task`'s scope), then those its extensions
 * started.
 */
export function componentTerminals(
  componentId: string,
  terminals: TerminalSpec[],
  runtimeTerminals: Snapshot['runtimeTerminals'],
  task: string | null = null,
): [string, TerminalSpec][] {
  return [
    ...terminals.map((t): [string, TerminalSpec] => [sessionId(componentId, t.id, task), t]),
    ...Object.entries(runtimeTerminals)
      .filter(([, r]) => r.projectId === useStore.getState().project?.id)
      .filter(([, r]) => r.componentId === componentId && (r.taskId ?? null) === task)
      .filter(([sid]) => !terminals.some((t) => sessionId(componentId, t.id, task) === sid))
      .map(([sid, r]): [string, TerminalSpec] => [sid, r.terminal]),
  ]
}

/** The most urgent status among a component's terminals, if any wants the user. */
export function componentAttention(
  componentId: string,
  terminals: TerminalSpec[],
  sessions: Record<string, SessionState>,
  runtimeTerminals: Snapshot['runtimeTerminals'],
  task: string | null = null,
): TerminalStatus | null {
  return mostUrgent(
    componentTerminals(componentId, terminals, runtimeTerminals, task).map(([sid, t]) =>
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
 * extension started, which aren't tiled) its tab in the Navigation dock. Switches to the
 * session's task first.
 */
export function revealTerminal(item: Pick<AttentionItem, 'sid' | 'componentId'>) {
  const s = useStore.getState()
  s.setActiveTask(sessionTask(item.sid))
  if (item.componentId === PLAN_SCOPE) {
    const { terminalId } = parseSessionId(item.sid)
    if (!terminalId) return
    s.setPlanActive(terminalId)
    s.setView('plan')
    return
  }
  if (item.componentId === TASK_ROOT_SCOPE) {
    s.setView('implementation')
    s.setActiveSession(item.sid)
    s.setRevealed(item)
    s.setMaximizedTerminal(null)
    return
  }
  s.setMaximizedTerminal(null)
  s.select(item.componentId)
  s.setActiveSession(item.sid)
  if (s.runtimeTerminals[item.sid]) {
    s.setView('navigation')
    return
  }
  // Highlights are the planner's scope and agents' peers, so revealing never changes them.
  s.setRevealed({ componentId: item.componentId, sid: item.sid })
  s.setView('implementation')
}
