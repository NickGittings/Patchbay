import { ownsPlanner, relatedSession } from './simple'
import { simpleKey, useSimpleUi } from './simpleUi'
import { autoWorkspace } from './autoState'
import { STAGE_LABELS, STATUS_LABELS } from './autoSettings'
import { useStore } from '../store'
import {
  MAP_SCOPE,
  PLAN_SCOPE,
  MERGE_SCOPE,
  REVIEW_SCOPE,
  isReviewAgentScope,
  TASK_ROOT_SCOPE,
  sessionView,
  parseSessionId,
  plannerSessionId,
  sessionId,
  sessionTask,
  type AutoRun,
  type SessionState,
  type SessionRecord,
  type TerminalSpec,
} from '../types'
import { mostUrgent, terminalStatus, type TerminalStatus } from './display'
import { planTerminals } from './plan'
import { unseenFinished } from './taskActions'

export interface AttentionItem {
  auto?: boolean
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
    Pick<
      ReturnType<typeof useStore.getState>,
      'auto' | 'rootTerminals' | 'taskWorkspaces' | 'activeTask' | 'sessionRecords'
    >
  >

/** Shared labels and task lookup for attention items and notifications. */
export function sessionOwner(componentId: string | undefined, nodes: Snapshot['nodes']) {
  if (componentId === PLAN_SCOPE) return 'Planner'
  if (componentId === TASK_ROOT_SCOPE) return 'Task root'
  if (componentId === REVIEW_SCOPE) return 'Review agent'
  if (componentId === MERGE_SCOPE) return 'Merge agent'
  if (componentId === MAP_SCOPE) return 'Map agent'
  return nodes.find((n) => n.id === componentId)?.data.name ?? componentId ?? 'Agent'
}

export function recordTask(record: SessionRecord, tasks: Snapshot['tasks']) {
  // Review and merge records carry branch scope; their cwd identifies the task.
  return isReviewAgentScope(record.metadata.componentId)
    ? tasks.find((t) => !t.missing && t.worktree === record.spec.cwd)
    : tasks.find((t) => t.id === record.metadata.task)
}

function since(session: SessionState | undefined) {
  return session?.status?.agent?.sinceMs ?? session?.exitedMs ?? session?.startedMs ?? 0
}

type AutoSnapshot = Pick<Snapshot, 'tasks' | 'auto' | 'taskWorkspaces' | 'activeTask'>

function worktreeScopes(s: Pick<Snapshot, 'tasks'>): [string | null, string | undefined][] {
  return [[null, undefined], ...(s.tasks ?? []).map((t): [string, string] => [t.id, t.title])]
}

/**
 * Auto runs of a project that want the user: waiting on you (an input wait, a pause it can't
 * resolve, or the merge gate asking for approval) or failed.
 */
export function autoAttentionItems(s: AutoSnapshot): (AttentionItem & { run: AutoRun })[] {
  return worktreeScopes(s).flatMap(([task, taskTitle]) => {
    const run = autoWorkspace(s, task)?.auto
    if (!run || !['waitingOnYou', 'failed'].includes(run.status)) return []
    return [
      {
        auto: true,
        run,
        sid: `auto:${task ?? ''}`,
        componentId: '@auto',
        owner: 'Auto mode',
        task,
        taskTitle,
        terminal: { id: 'auto', name: STAGE_LABELS[run.stage], command: '', kind: 'agent' },
        status: {
          health: run.status === 'failed' ? 'fail' : 'input',
          attention: run.status === 'failed' ? 3 : 4,
          label: STATUS_LABELS[run.status],
          detail: run.reason,
        },
        sinceMs: run.log.at(-1)?.atMs ?? 0,
      },
    ]
  })
}

/**
 * Every terminal that wants the user, in the open worktree and in every task, most urgent first,
 * oldest first within a level.
 */
export function attentionItems(s: Snapshot, now = Date.now()): AttentionItem[] {
  const scopes = worktreeScopes(s)
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
      // The planner belongs to the project, so it is listed once, with the project folder.
      ...(task === null ? planTerminals(s.devices) : []).map((terminal) => ({
        sid: plannerSessionId(terminal.id),
        componentId: PLAN_SCOPE,
        owner: 'Planner',
        task,
        taskTitle,
        terminal,
      })),
    ]),
    // Review and merge jobs are recovered from records, never registered as component runtimes.
    ...(s.sessionRecords ?? [])
      .filter(
        (r) =>
          r.metadata.projectId === useStore.getState().project?.id &&
          isReviewAgentScope(r.metadata.componentId),
      )
      .map((r) => {
        const task = recordTask(r, s.tasks)
        return {
          sid: r.id,
          componentId: r.metadata.componentId,
          owner: sessionOwner(r.metadata.componentId, s.nodes),
          task: task?.id ?? null,
          taskTitle: task?.title,
          terminal: {
            id: r.metadata.terminalId,
            name: r.metadata.name,
            kind: r.metadata.kind,
            command: r.spec.command,
          },
        }
      }),
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
        owner: sessionOwner(r.componentId, s.nodes),
        task: r.taskId ?? sessionTask(sid),
        taskTitle: s.tasks.find((t) => t.id === (r.taskId ?? sessionTask(sid)))?.title,
        terminal: r.terminal,
      })),
  ]
  const autoItems = autoAttentionItems(s)
  return [
    ...autoItems,
    ...terminals
      .filter((t, index) => terminals.findIndex((other) => other.sid === t.sid) === index)
      .map((t) => {
        const session = s.sessions[t.sid]
        return {
          ...t,
          status: terminalStatus(t.terminal.kind, session, now),
          sinceMs: since(session),
        }
      })
      .filter((item) => item.status.attention > 0),
  ].sort((a, b) => b.status.attention - a.status.attention || a.sinceMs - b.sinceMs)
}

/**
 * How many terminals want the user per task (`''` for the open worktree), as a string so a store
 * selector only re-renders when a count changes.
 */
export function attentionCounts(s: Snapshot): string {
  return JSON.stringify(countAttention(s))
}

function countAttention(s: Snapshot): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of attentionItems(s)) {
    const key = item.task ?? ''
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/**
 * `attentionCounts` plus each other worktree's finished graph actions (validation, environments)
 * the user hasn't seen there, for the worktree picker. The worktree on screen counts none: its
 * actions are marked seen when it is left (the store's `leaveWorktree`). Returns a fresh object of numbers,
 * for `useShallow`.
 */
export function worktreeAttention(
  s: Snapshot &
    Pick<ReturnType<typeof useStore.getState>, 'project' | 'taskActivities' | 'seenActivities'>,
): Record<string, number> {
  const counts = countAttention(s)
  const activities = Object.values(s.taskActivities)
  if (!activities.length) return counts
  const seen = new Set(s.seenActivities)
  for (const activity of activities) {
    const task = activity.task ?? null
    if (task !== (s.activeTask ?? null) && unseenFinished(activity, s.project?.id, task, seen))
      counts[task ?? ''] = (counts[task ?? ''] ?? 0) + 1
  }
  return counts
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

/**
 * Show a terminal: its tab in the planner, its tile in Implementation, or (for terminals an
 * extension started, which aren't tiled) its tab in the Navigation dock. Switches to the
 * session's task first, except for extension and planner terminals.
 */
export function revealTerminal(
  item: Pick<AttentionItem, 'sid' | 'componentId'> & Partial<Pick<AttentionItem, 'auto' | 'task'>>,
) {
  const s = useStore.getState()
  if (s.simpleMode && s.project) {
    const record = s.sessionRecords.find((r) => r.id === item.sid)
    if (record) {
      const generation = (s.sessions[record.id] ?? record.snapshot)?.generation
      const plannerTask = ownsPlanner(s.simple, record.id, generation)
        ? s.activeTask
        : Object.entries(s.taskWorkspaces).find(
            ([task, workspace]) =>
              (task || null) !== s.activeTask &&
              ownsPlanner(workspace.simple, record.id, generation),
          )?.[0]
      const task =
        record.metadata.componentId === PLAN_SCOPE
          ? plannerTask === undefined
            ? s.activeTask
            : plannerTask || null
          : record.metadata.componentId === MERGE_SCOPE
            ? (s.tasks.find((t) => t.worktree === record.spec.merge_source)?.id ?? null)
            : (s.tasks.find((t) => t.id === record.metadata.task)?.id ??
              s.tasks.find((t) => t.worktree === record.spec.cwd)?.id ??
              null)
      const worktree = s.tasks.find((t) => t.id === task)
      const path = worktree?.worktree ?? s.project.root
      if (
        relatedSession(record, { projectId: s.project.id, task, path, branch: worktree?.branch })
      ) {
        if (task !== s.activeTask) s.setActiveTask(task, true)
        s.setActiveSession(item.sid)
        // A planner launched outside Chat has no conversation block; its terminal is still
        // accessible in the chat drawer without changing the conversation's ownership.
        if (record.metadata.componentId === PLAN_SCOPE && plannerTask === undefined) {
          useSimpleUi.getState().patch(simpleKey(s.project.id, task), {
            terminal: 'user',
            terminalSession: { id: record.id, generation, pinned: true },
          })
          useStore.getState().setRevealed(null)
        } else useStore.getState().setRevealed({ componentId: item.componentId, sid: item.sid })
        return
      }
    }
  }
  if (item.auto) {
    s.setActiveTask(item.task ?? null, true)
    s.showAutoPanel()
    return
  }
  if (isReviewAgentScope(item.componentId)) {
    s.setActiveSession(item.sid)
    s.setView(sessionView(item.componentId)!)
    return
  }
  // Dependency detection shows in Navigation's dock in every worktree, so it switches none.
  if (item.componentId === MAP_SCOPE) {
    s.select(null)
    s.setActiveSession(item.sid)
    s.setView('navigation')
    return
  }
  const runtime = s.runtimeTerminals[item.sid]
  const extension = !!(runtime?.extensionId || runtime?.commandId)
  // Extension terminals run in the open worktree and show in any task, and the planner in every
  // task, so neither switches it.
  if (!extension && item.componentId !== PLAN_SCOPE) s.setActiveTask(sessionTask(item.sid), true)
  s.setActiveSession(item.sid)
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
  if (extension) {
    s.setView('navigation')
    return
  }
  // Highlights are the planner's scope and agents' peers, so revealing never changes them.
  s.setRevealed({ componentId: item.componentId, sid: item.sid })
  s.setView('implementation')
}
