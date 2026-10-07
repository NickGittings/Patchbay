import type { TaskWorkspace, FlowNode } from '../store'
import {
  TASK_ROOT_SCOPE,
  sessionId,
  type RuntimeTerminal,
  type SessionState,
  type TerminalSpec,
} from '../types'

export interface TaskTerminal {
  componentId: string
  label: string
  terminal: TerminalSpec
  sid: string
  retained?: boolean
}
/** Scope, layout and launch identity are resolved together for one checkout. */
export function taskTerminals(
  workspace: Pick<TaskWorkspace, 'rootTerminals' | 'highlighted'>,
  nodes: FlowNode[],
  runtimes: Record<string, RuntimeTerminal>,
  projectId: string,
  task: string | null,
  sessions: Record<string, SessionState> = {},
): TaskTerminal[] {
  const entries: TaskTerminal[] = [
    ...workspace.rootTerminals.map((terminal) => ({
      componentId: TASK_ROOT_SCOPE,
      label: 'Task root',
      terminal,
      sid: sessionId(TASK_ROOT_SCOPE, terminal.id, task, projectId),
    })),
    ...nodes
      .filter(
        (n) =>
          workspace.highlighted.includes(n.id) ||
          n.data.terminals.some((t) => sessions[sessionId(n.id, t.id, task, projectId)]?.running),
      )
      .flatMap((n) =>
        n.data.terminals.map((terminal) => ({
          componentId: n.id,
          label: n.data.name,
          terminal,
          sid: sessionId(n.id, terminal.id, task, projectId),
        })),
      ),
  ]
  for (const [sid, runtime] of Object.entries(runtimes)) {
    if (
      runtime.projectId !== projectId ||
      (runtime.taskId ?? null) !== task ||
      entries.some((e) => e.sid === sid)
    )
      continue
    entries.push({
      componentId: runtime.componentId,
      label: nodes.find((n) => n.id === runtime.componentId)?.data.name ?? 'Task root',
      terminal: runtime.terminal,
      sid,
      retained: true,
    })
  }
  return entries
}
export function visibleTaskTerminals(
  entries: TaskTerminal[],
  visible: string[] | null,
  maximized: string | null,
) {
  const shown = visible ? entries.filter((e) => visible.includes(e.sid)) : entries
  return shown.some((e) => e.sid === maximized) ? shown.filter((e) => e.sid === maximized) : shown
}
