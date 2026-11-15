import { projectStateOf, useStore, workspaceOf } from '../store'
import {
  MAP_SCOPE,
  PLAN_SCOPE,
  PROJECT_DRAFT,
  TASK_ROOT_SCOPE,
  isReviewAgentScope,
  plannerChatTask,
  plannerSessionId,
  type SessionRecord,
} from '../types'
import { revealTerminal, terminalChatDestination } from './attention'
import { planTerminals } from './plan'
import { refreshSession } from './sessions'

/** Check the open tab's live/saved workspace without activating or reopening a project. */
export function sessionDestinationAvailable(record: SessionRecord): boolean {
  const s = useStore.getState()
  const { projectId, componentId, terminalId } = record.metadata
  const project = projectStateOf(projectId, s)
  if (!project?.project) return false
  const availableTask = (task: string | null) =>
    task === null || project.tasks.some((t) => t.id === task && !t.missing)
  // Ask the same resolver as revealTerminal: Chat can retain a terminal even after its preset
  // was removed, and can own a planner or merge in a different worktree from its launch folder.
  const chat = terminalChatDestination(record, { ...s, ...project })
  if (chat) return availableTask(chat.task)
  // Review jobs and project detection have their own destinations, independent of worktrees.
  if (isReviewAgentScope(componentId)) return true
  const runtime = s.runtimeTerminals[record.id]
  const retained =
    runtime?.projectId === projectId &&
    runtime.componentId === componentId &&
    runtime.terminal.id === terminalId
  if (componentId === MAP_SCOPE) return retained
  const task = plannerChatTask(record.metadata.task)
  if (task !== PROJECT_DRAFT && !availableTask(task)) return false
  if (componentId === PLAN_SCOPE)
    return (
      planTerminals(s.devices).some((t) => t.id === terminalId) &&
      plannerSessionId(terminalId, projectId, task) === record.id
    )
  if (task === PROJECT_DRAFT) return false
  if (retained)
    return (
      !(runtime.extensionId || runtime.commandId) || (runtime.taskId ?? null) === project.activeTask
    )
  return componentId === TASK_ROOT_SCOPE
    ? workspaceOf(project, task).rootTerminals.some((t) => t.id === terminalId)
    : project.nodes.some(
        (n) => n.id === componentId && n.data.terminals.some((t) => t.id === terminalId),
      )
}

export type SessionReconnectResult = 'revealed' | 'unavailable' | 'ended'

/** Attach to an existing run only; a live exit during hydration wins over its saved listing. */
export async function reconnectSession(record: SessionRecord): Promise<SessionReconnectResult> {
  // Pane hydration is cached, including a null read made before a shell first started. An
  // explicit reconnect needs a fresh snapshot of the current run and buffered live events.
  const snapshot = await refreshSession(record.id)
  const s = useStore.getState()
  if (!snapshot || !(s.sessions[record.id] ?? snapshot).running) return 'ended'
  if (!sessionDestinationAvailable(record)) return 'unavailable'
  if (s.project?.id !== record.metadata.projectId) s.activateProject(record.metadata.projectId)
  revealTerminal({ sid: record.id, componentId: record.metadata.componentId })
  return 'revealed'
}
