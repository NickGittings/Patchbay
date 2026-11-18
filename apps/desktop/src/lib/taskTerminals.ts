import type { TaskWorkspace, FlowNode } from '../store'
import { sessionRole } from './sessionList'
import {
  MAP_SCOPE,
  TASK_ROOT_SCOPE,
  showsInDock,
  sessionId,
  type RuntimeTerminal,
  type SessionRecord,
  type SessionState,
  type TerminalSpec,
} from '../types'

export interface TaskTerminal {
  componentId: string
  /** The map component's name; absent when no component on the map owns the terminal. */
  label?: string
  terminal: TerminalSpec
  sid: string
  retained?: boolean
}
/**
 * A task's terminals: its own root terminals, the saved component terminals added to it, then
 * any other session running in its worktree (started by an environment, validation or an agent,
 * or no longer on the map) so nothing it runs is out of sight.
 */
export function taskTerminals(
  workspace: Pick<TaskWorkspace, 'rootTerminals' | 'componentTerminals'>,
  nodes: FlowNode[],
  runtimes: Record<string, RuntimeTerminal>,
  projectId: string,
  task: string | null,
  sessions: Record<string, SessionState> = {},
): TaskTerminal[] {
  const component = (node: FlowNode, terminal: TerminalSpec): TaskTerminal => ({
    componentId: node.id,
    label: node.data.name,
    terminal,
    sid: sessionId(node.id, terminal.id, task, projectId),
  })
  const entries: TaskTerminal[] = [
    ...workspace.rootTerminals.map((terminal) => ({
      componentId: TASK_ROOT_SCOPE,
      terminal,
      sid: sessionId(TASK_ROOT_SCOPE, terminal.id, task, projectId),
    })),
    ...workspace.componentTerminals.flatMap(({ componentId, terminalId }) => {
      const node = nodes.find((n) => n.id === componentId)
      const terminal = node?.data.terminals.find((t) => t.id === terminalId)
      return node && terminal ? [component(node, terminal)] : []
    }),
  ]
  for (const node of nodes)
    for (const terminal of node.data.terminals) {
      const entry = component(node, terminal)
      if (sessions[entry.sid]?.running && !entries.some((e) => e.sid === entry.sid))
        entries.push(entry)
    }
  for (const [sid, runtime] of Object.entries(runtimes)) {
    if (
      // Dependency detection belongs to the project, not a worktree's work.
      !showsInDock(runtime.componentId) ||
      runtime.componentId === MAP_SCOPE ||
      !sessions[sid]?.running ||
      runtime.projectId !== projectId ||
      (runtime.taskId ?? null) !== task ||
      entries.some((e) => e.sid === sid)
    )
      continue
    entries.push(retainedTerminal(sid, runtime, nodes))
  }
  return entries
}
/** A session the map no longer names, shown with what its record says it ran. */
export function retainedTerminal(
  sid: string,
  runtime: RuntimeTerminal,
  nodes: FlowNode[],
): TaskTerminal {
  return {
    componentId: runtime.componentId,
    label: nodes.find((n) => n.id === runtime.componentId)?.data.name,
    terminal: runtime.terminal,
    sid,
    retained: true,
  }
}
/**
 * What a tile's header leads with: its component, else the kind of agent it holds. The session's
 * record decides when there is one, since only it knows a root agent is fixing a review.
 */
export function tileLabel(
  { componentId, label, terminal }: Pick<TaskTerminal, 'componentId' | 'label' | 'terminal'>,
  record?: Pick<SessionRecord, 'metadata'>,
): string | undefined {
  if (label) return label
  const metadata = record?.metadata ?? {
    componentId,
    kind: terminal.kind,
    terminalId: terminal.id,
  }
  return metadata.kind === 'agent' ? sessionRole(metadata).role : undefined
}
/** With a maximized terminal, only that one. */
export function shownTaskTerminals(entries: TaskTerminal[], maximized: string | null) {
  return entries.some((e) => e.sid === maximized)
    ? entries.filter((e) => e.sid === maximized)
    : entries
}
