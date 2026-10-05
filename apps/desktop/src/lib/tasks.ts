import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useStore } from '../store'
import { sessionTask, type Task, type TaskDraft } from '../types'
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
 * Reload the task list from the backend (main window only; pop-outs get it broadcast). A failure
 * keeps the list as it was (a project outside a git repo simply has none).
 */
export async function refreshTasks() {
  const { project } = useStore.getState()
  if (getCurrentWebviewWindow().label !== 'main' || !project) return
  try {
    const tasks = await taskList()
    if (useStore.getState().project === project) useStore.getState().setTasks(tasks)
  } catch (e) {
    if (useStore.getState().tasks.length) useStore.getState().setMessage(String(e))
  }
}

/**
 * Keep the backend's watcher and the Git badges on the active task's worktree. The main window
 * calls this once; switching tasks never stops terminals.
 */
export function followActiveTask() {
  let last = useStore.getState().activeTask
  // One activation at a time, always for the latest task, so a slow earlier call can't leave the
  // watcher on a worktree the user already switched away from.
  let sent: string | null | undefined
  let activating: Promise<void> | undefined
  const activate = (): Promise<void> => {
    activating ??= (async () => {
      while (useStore.getState().project && sent !== useStore.getState().activeTask) {
        sent = useStore.getState().activeTask
        await taskActivate(sent).catch((e) => useStore.getState().setMessage(String(e)))
      }
    })().finally(() => {
      activating = undefined
    })
    return activating
  }
  return useStore.subscribe((s, prev) => {
    // A new project's backend starts without a task.
    if (s.project !== prev.project) sent = null
    if (s.activeTask === last) return
    last = s.activeTask
    void activate()
    invalidateGitRefresh()
    useStore.getState().setGitStatus({ changes: {}, repos: {} })
    void requestGitRefresh()
  })
}

export async function createTask(draft: TaskDraft): Promise<Task> {
  const task = await taskCreate(draft)
  await refreshTasks()
  useStore.getState().setActiveTask(task.id)
  return task
}

export async function attachTask(worktree: string, components: string[]): Promise<Task> {
  const task = await taskAttach(worktree, undefined, components)
  await refreshTasks()
  useStore.getState().setActiveTask(task.id)
  return task
}

/** Stop a task's terminals and wait (up to 10s) for them to exit. */
async function stopTaskSessions(id: string) {
  const sids = Object.entries(useStore.getState().sessions)
    .filter(([sid, session]) => session.running && sessionTask(sid) === id)
    .map(([sid]) => sid)
  await Promise.all(sids.map((sid) => terminalStop(sid).catch(() => {})))
  const deadline = Date.now() + 10000
  for (const sid of sids)
    while ((await terminalSnapshot(sid).catch(() => null))?.running && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100))
}

/**
 * Stop the task's terminals (nothing would show them once it is gone), then forget it and, with
 * `deleteWorktree`, remove its worktree.
 */
export async function removeTask(id: string, deleteWorktree: boolean) {
  // Ask first, so a worktree git won't remove doesn't cost the task its running terminals.
  if (deleteWorktree) await taskCheckRemovable(id)
  await stopTaskSessions(id)
  if (useStore.getState().activeTask === id) useStore.getState().setActiveTask(null)
  try {
    await taskRemove(id, deleteWorktree)
  } finally {
    await refreshTasks()
  }
}

/** A branch name from a title: `Fix login bug` → `fix-login-bug`. */
export function branchFor(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9/._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '')
}
