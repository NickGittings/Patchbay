import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { projectOf, useStore } from '../store'
import { sessionMetadata, sessionTask, type Task, type TaskDraft } from '../types'
import { invalidateGitRefresh, requestGitRefresh } from './git'
import {
  taskActivate,
  taskAttach,
  taskCheckRemovable,
  taskCreate,
  taskList,
  taskRemove,
  terminalSnapshot,
  terminalStop,
} from './ipc'

type Snapshot = Pick<ReturnType<typeof useStore.getState>, 'tasks' | 'activeTask'>

/** The active task, if any. */
export const activeTaskOf = (s: Snapshot): Task | undefined =>
  s.activeTask ? s.tasks.find((t) => t.id === s.activeTask) : undefined

/**
 * The worktree path to pass to `gitDiff`/`gitReview` for the active task; `undefined` for the
 * open worktree (including a task whose worktree the project is open in).
 */
export function activeWorktree(s: Snapshot): string | undefined {
  const task = activeTaskOf(s)
  return task && !task.current ? task.worktree : undefined
}

/**
 * Reload a project's task list from the backend (main window only; pop-outs get it broadcast). A
 * failure keeps the list as it was (a project outside a git repo simply has none).
 */
export async function refreshTasks(projectId = useStore.getState().project?.id) {
  if (getCurrentWebviewWindow().label !== 'main' || !projectId) return
  try {
    applyTasks(projectId, await taskList(projectId))
  } catch (e) {
    if (useStore.getState().project?.id === projectId && useStore.getState().tasks.length)
      useStore.getState().setMessage(String(e))
  }
}

/** Set a project's tasks, whether or not its tab is active, dropping a vanished active task. */
function applyTasks(projectId: string, tasks: Task[]) {
  const map = projectOf(projectId)
  if (map) {
    const ids = new Set(map.components.map((c) => c.id))
    tasks = tasks.map((task) => ({
      ...task,
      components: task.components.filter((id) => ids.has(id)),
    }))
  }
  const s = useStore.getState()
  if (s.project?.id === projectId) {
    s.setTasks(tasks)
    return
  }
  const state = s.projects[projectId]?.state
  if (!state) return
  const keep = tasks.some((t) => t.id === state.activeTask && !t.missing)
  s.patchProject(projectId, { tasks, activeTask: keep ? state.activeTask : null })
}

/** Switch a project's task, whether or not its tab is active. */
function activateTaskIn(projectId: string, task: string | null) {
  const s = useStore.getState()
  if (s.project?.id === projectId) s.setActiveTask(task)
  else s.patchProject(projectId, { activeTask: task })
}

/**
 * Keep each project's backend watcher and Git badges on its active task's worktree. The main
 * window calls this once; switching tasks never stops terminals, and switching project tabs is
 * not a task switch.
 */
export function followActiveTask() {
  // The task last sent to each project's backend, so a slow earlier call can't leave the
  // watcher on a worktree the user already switched away from.
  const sent = new Map<string, string | null>()
  const activating = new Map<string, Promise<void>>()
  const activate = (projectId: string): Promise<void> => {
    const current = () => useStore.getState().captureProjects()[projectId]?.state?.activeTask
    let running = activating.get(projectId)
    running ??= (async () => {
      while (current() !== undefined && sent.get(projectId) !== current()) {
        const task = current() ?? null
        sent.set(projectId, task)
        await taskActivate(task, projectId).catch((e) => useStore.getState().setMessage(String(e)))
      }
    })().finally(() => activating.delete(projectId))
    activating.set(projectId, running)
    return running
  }
  return useStore.subscribe((s, prev) => {
    // A closed project's backend state is gone; reopening it starts from scratch.
    if (s.projects !== prev.projects)
      for (const id of sent.keys()) if (!s.projects[id] && s.project?.id !== id) sent.delete(id)
    const id = s.project?.id
    if (!id) return
    // Also covers a task restored with the workspace, which the backend hasn't heard of.
    if ((sent.get(id) ?? null) !== s.activeTask) void activate(id)
    if (id !== prev.project?.id || s.activeTask === prev.activeTask) return
    invalidateGitRefresh(id)
    useStore.getState().setGitStatus({ changes: {}, repos: {} })
    void requestGitRefresh(id)
  })
}

export async function createTask(draft: TaskDraft): Promise<Task> {
  const projectId = useStore.getState().project?.id
  if (!projectId) throw new Error('Open a project first')
  const task = await taskCreate(draft, projectId)
  await refreshTasks(projectId)
  activateTaskIn(projectId, task.id)
  return task
}

export async function attachTask(worktree: string, components: string[]): Promise<Task> {
  const projectId = useStore.getState().project?.id
  if (!projectId) throw new Error('Open a project first')
  const task = await taskAttach(worktree, undefined, components, projectId)
  await refreshTasks(projectId)
  activateTaskIn(projectId, task.id)
  return task
}

/** Stop a project's task terminals and wait (up to 10s) for them to exit. */
async function stopTaskSessions(projectId: string, id: string) {
  const sids = Object.entries(useStore.getState().sessions)
    .filter(
      ([sid, session]) =>
        session.running &&
        sessionTask(sid) === id &&
        sessionMetadata.get(sid)?.projectId === projectId,
    )
    .map(([sid]) => sid)
  await Promise.all(sids.map((sid) => terminalStop(sid).catch(() => {})))
  const deadline = Date.now() + 10000
  for (const sid of sids)
    while ((await terminalSnapshot(sid).catch(() => null))?.running && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100))
}

/**
 * Stop the task's terminals (nothing would show them once it is gone), then forget it and, with
 * `deleteWorktree`, remove its worktree. Stays with the project it was asked in.
 */
export async function removeTask(id: string, deleteWorktree: boolean) {
  const projectId = useStore.getState().project?.id
  if (!projectId) return
  // Ask first, so a worktree git won't remove doesn't cost the task its running terminals.
  if (deleteWorktree) await taskCheckRemovable(id, projectId)
  await stopTaskSessions(projectId, id)
  const state = useStore.getState().captureProjects()[projectId]?.state
  if (state?.activeTask === id) activateTaskIn(projectId, null)
  try {
    await taskRemove(id, deleteWorktree, projectId)
  } finally {
    await refreshTasks(projectId)
  }
}

/** Open the new-worktree dialog for the highlighted components, else the selected one. */
export function seedNewTask() {
  const s = useStore.getState()
  s.setNewTask(s.highlighted.length ? [...s.highlighted] : s.selectedId ? [s.selectedId] : [])
}

/** A branch name from a title: `Fix login bug` → `fix-login-bug`. */
export function branchFor(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9/._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '')
}
