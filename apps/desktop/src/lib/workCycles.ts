import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import {
  emptyTaskWorkspace,
  projectStateOf,
  taskWorkspace,
  useStore,
  workspaceOf,
  type TaskWorkspace,
} from '../store'
import { emptySimpleUi, simpleKey, useSimpleUi } from './simpleUi'
import { useChatTeams } from './chatTeams'
import { savePlanDraft, planDrafts } from './planDrafts'
import { autoDraftKey, autoDrafts } from './autoDrafts'

export interface FinishedTask {
  cycle: string
  nextCycle: string
  completedMs: number
  branch: string
  firstRequest: string
  workspace: TaskWorkspace & { chatUi?: unknown }
  coordination: unknown
  artifacts: { path: string; text: string }[]
  sessions: { id: string; name: string; conversationId: string | null }[]
}
export interface TaskCycleState {
  cycle: string
  finishing: FinishedTask | null
  history: FinishedTask[]
}
export const useTaskCycles = create<{ scopes: Record<string, TaskCycleState> }>(() => ({
  scopes: {},
}))

export function freshWorkspace(
  workspace: TaskWorkspace,
  cycle: string,
  nodes = useStore.getState().nodes,
): TaskWorkspace {
  return {
    ...emptyTaskWorkspace(),
    workCycle: cycle,
    finishingTask: false,
    rootTerminals: workspace.rootTerminals.filter((t) => t.kind !== 'agent'),
    componentTerminals: workspace.componentTerminals.filter(
      (t) =>
        nodes.find((n) => n.id === t.componentId)?.data.terminals.find((s) => s.id === t.terminalId)
          ?.kind !== 'agent',
    ),
  }
}
function apply(projectId: string, task: string | null, result: TaskCycleState) {
  const state = projectStateOf(projectId)
  if (!state) return result
  const key = simpleKey(projectId, task)
  const known = useTaskCycles.getState().scopes[key]
  if (
    known &&
    (known.history.length > result.history.length ||
      (known.finishing && known.cycle === result.cycle && !result.finishing))
  )
    return known
  const workspace = workspaceOf(state, task)
  // The journal is authoritative after a crash between archiving and saving the fresh UI.
  if ((workspace.workCycle ?? '') !== result.cycle) {
    useStore
      .getState()
      .patchTask(projectId, task, freshWorkspace(workspace, result.cycle, state.nodes))
    useSimpleUi.setState((s) => ({ worktrees: { ...s.worktrees, [key]: emptySimpleUi() } }))
    planDrafts.delete(`${projectId}\n${task ?? ''}`)
    autoDrafts.delete(autoDraftKey(projectId, task))
  } else useStore.getState().patchTask(projectId, task, { finishingTask: !!result.finishing })
  useTaskCycles.setState((s) => ({ scopes: { ...s.scopes, [key]: result } }))
  const retired = new Set(result.history.flatMap((a) => a.sessions.map((r) => r.id)))
  useStore.setState((s) => ({
    sessionRecords: s.sessionRecords.map((r) => (retired.has(r.id) ? { ...r, archived: true } : r)),
  }))
  const retiredRuns = new Set(
    result.history.flatMap((a) => {
      const coordination = a.coordination as { runs?: { id: string }[] } | null
      return coordination?.runs?.map((r) => r.id) ?? []
    }),
  )
  useChatTeams.setState((s) => ({
    teams: {
      ...s.teams,
      [projectId]: (s.teams[projectId] ?? []).filter(
        (t) =>
          t.task !== task ||
          !result.history.some((a) => a.sessions.some((r) => r.id === t.lead.sessionId)),
      ),
    },
    runs: {
      ...s.runs,
      [projectId]: (s.runs[projectId] ?? []).filter((r) => !retiredRuns.has(r.id)),
    },
  }))
  return result
}
export async function refreshTaskCycle(projectId: string, task: string | null) {
  const result = await invoke<TaskCycleState>('task_cycle_state', { projectId, task })
  return apply(projectId, task, result)
}
export async function restoreTaskCycles() {
  for (const [projectId, project] of Object.entries(useStore.getState().captureProjects())) {
    if (!project.state) continue
    for (const task of new Set([
      null,
      project.state.activeTask,
      ...Object.keys(project.state.taskWorkspaces).map((k) => k || null),
    ]))
      await refreshTaskCycle(projectId, task)
  }
}
const finishing = new Map<string, Promise<void>>()
export function finishTask(projectId: string, task: string | null) {
  const key = simpleKey(projectId, task)
  const existing = finishing.get(key)
  if (existing) return existing
  const request = finish(projectId, task).finally(() => finishing.delete(key))
  finishing.set(key, request)
  return request
}
async function finish(projectId: string, task: string | null) {
  const state = projectStateOf(projectId)
  if (!state) throw new Error('Project is unavailable')
  const workspace = taskWorkspace(workspaceOf(state, task))
  const key = simpleKey(projectId, task)
  useStore.getState().patchTask(projectId, task, {
    finishingTask: true,
    ...(workspace.auto
      ? {
          auto: {
            ...workspace.auto,
            runId: crypto.randomUUID(),
            status: 'stopped',
            reason: 'Finishing task',
          },
        }
      : {}),
  })
  try {
    const { flushWorkspace } = await import('./workspace')
    await savePlanDraft(projectId, task)
    await flushWorkspace(true)
    const result = await invoke<TaskCycleState>('task_cycle_finish', {
      projectId,
      task,
      cycle: workspace.workCycle ?? '',
      workspace: { ...workspace, chatUi: useSimpleUi.getState().worktrees[key] },
    })
    apply(projectId, task, result)
    await flushWorkspace(true)
    const { reconcileFreshSessions } = await import('./sessions')
    await reconcileFreshSessions()
  } catch (error) {
    // A lost response may already have completed. Reconcile the durable receipt before retrying.
    await refreshTaskCycle(projectId, task).catch(() => {})
    throw error
  }
}
