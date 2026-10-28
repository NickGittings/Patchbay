export { shortTitle } from './shortTitle'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import {
  projectOf,
  projectStateOf,
  reconcileTaskList,
  switchTaskWorkspace,
  useStore,
} from '../store'
import type { Task, TaskDraft } from '../types'
import { taskActionState, unseenFinished } from './taskActions'
import { forgetAutoDrafts } from './autoDrafts'
import { invalidateGitRefresh, requestGitRefresh } from './git'
import { reconcileFreshSessions } from './sessions'
import {
  planRead,
  planWrite,
  taskActivate,
  taskAttach,
  taskCreate,
  taskList,
  taskRemove,
  taskUpdate,
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

/** Each project's latest task list request, and the newest one whose list was applied. */
const requested = new Map<string, number>()
const applied = new Map<string, number>()
const pending = new Map<string, Promise<void>>()

/**
 * Reload a project's task list from the backend (main window only; pop-outs get it broadcast). A
 * failure keeps the list as it was (a project outside a git repo simply has none). A list older
 * than one already applied may miss a worktree created since, which would drop it as the active
 * task and prune its draft, so it is ignored; callers return once the newest request settles.
 */
export async function refreshTasks(projectId = useStore.getState().project?.id) {
  if (getCurrentWebviewWindow().label !== 'main' || !projectId) return
  const seq = (requested.get(projectId) ?? 0) + 1
  requested.set(projectId, seq)
  const request = (async () => {
    try {
      const tasks = await taskList(projectId)
      if (seq <= (applied.get(projectId) ?? 0)) return
      applied.set(projectId, seq)
      applyTasks(projectId, tasks)
    } catch (e) {
      const s = useStore.getState()
      if (seq === requested.get(projectId) && s.project?.id === projectId && s.tasks.length)
        s.setMessage(String(e))
    }
  })()
  pending.set(projectId, request)
  let settled = request
  await settled
  while (pending.get(projectId) !== settled) {
    settled = pending.get(projectId)!
    await settled
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
  // Worktrees removed elsewhere (another window, the CLI, by hand) leave no draft behind.
  const listed = new Set(tasks.map((t) => t.id))
  forgetAutoDrafts(projectId, (task) => task !== null && !listed.has(task))
  const s = useStore.getState()
  if (s.project?.id === projectId) {
    s.setTasks(tasks)
    return
  }
  const state = projectStateOf(projectId, s)
  if (!state) return
  s.patchProject(projectId, reconcileTaskList(state, tasks))
}

/** Switch a project's task, whether or not its tab is active. */
function activateTaskIn(projectId: string, task: string | null) {
  const s = useStore.getState()
  if (s.project?.id === projectId) s.setActiveTask(task)
  else {
    const state = projectStateOf(projectId, s)
    if (!state) return
    s.patchProject(projectId, switchTaskWorkspace(state, task))
  }
}

/**
 * Keep each project's backend watcher and Git badges on its active task's worktree. The main
 * window calls this once; switching tasks never stops terminals, and switching project tabs is
 * not a task switch.
 */
export function followActiveTask() {
  const listener = listen<import('../types').TaskActivity>('patchbay://task-activity', (event) =>
    applyTaskActivity(event.payload),
  )
  // The task last sent to each project's backend, so a slow earlier call can't leave the
  // watcher on a worktree the user already switched away from.
  const scopeWrites = new Map<string, Promise<unknown>>()
  const scopeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingScopes = new Map<string, { projectId: string; task: string; components: string[] }>()
  const flushScope = (key: string) => {
    clearTimeout(scopeTimers.get(key))
    scopeTimers.delete(key)
    const pending = pendingScopes.get(key)
    if (!pending) return
    pendingScopes.delete(key)
    const { projectId, task, components } = pending
    const write = (scopeWrites.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => taskUpdate(task, { components }, projectId))
      .then((updated) => {
        const state = useStore.getState().captureProjects()[projectId]?.state
        if (state)
          applyTasks(
            projectId,
            state.tasks.map((t) => (t.id === task ? updated : t)),
          )
      })
      .catch((e) => useStore.getState().setMessage(String(e)))
      .finally(() => {
        if (scopeWrites.get(key) === write) scopeWrites.delete(key)
      })
    scopeWrites.set(key, write)
  }
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
  const unsubscribe = useStore.subscribe((s, prev) => {
    // A closed project's backend state is gone; reopening it starts from scratch.
    if (s.projects !== prev.projects)
      for (const id of sent.keys()) if (!s.projects[id] && s.project?.id !== id) sent.delete(id)
    const id = s.project?.id
    if (!id) return
    if (
      s.activeTask &&
      s.activeTask === prev.activeTask &&
      id === prev.project?.id &&
      s.highlighted !== prev.highlighted
    ) {
      const task = s.activeTask
      const components = [...s.highlighted]
      const key = `${id}/${task}`
      pendingScopes.set(key, { projectId: id, task, components })
      clearTimeout(scopeTimers.get(key))
      scopeTimers.set(
        key,
        setTimeout(() => flushScope(key), 250),
      )
    }
    // Also covers a task restored with the workspace, which the backend hasn't heard of.
    if ((sent.get(id) ?? null) !== s.activeTask) void activate(id)
    if (id !== prev.project?.id || s.activeTask === prev.activeTask) return
    invalidateGitRefresh(id)
    useStore.getState().setGitStatus({ changes: {}, repos: {} })
    void requestGitRefresh(id)
  })
  return () => {
    unsubscribe()
    for (const key of pendingScopes.keys()) flushScope(key)
    void listener.then((unlisten) => unlisten())
  }
}

export async function createTask(draft: TaskDraft): Promise<Task> {
  const projectId = useStore.getState().project?.id
  if (!projectId) throw new Error('Open a project first')
  const task = await taskCreate(draft, projectId)
  await refreshTasks(projectId)
  activateTaskIn(projectId, task.id)
  await afterNewTask(task, projectId, true)
  return task
}

export async function attachTask(
  worktree: string,
  components: string[],
  title?: string,
): Promise<Task> {
  const projectId = useStore.getState().project?.id
  if (!projectId) throw new Error('Open a project first')
  const task = await taskAttach(worktree, title, components, projectId)
  await refreshTasks(projectId)
  activateTaskIn(projectId, task.id)
  await afterNewTask(task, projectId, false)
  return task
}

/**
 * Forget the task and, with `deleteWorktree`, remove its worktree. The backend stops the task's
 * sessions in every project first and forgets them after, since they can't resume without it.
 * Stays with the project it was asked in.
 */
export async function removeTask(id: string, deleteWorktree: boolean) {
  const projectId = useStore.getState().project?.id
  if (!projectId) return
  let cleared: boolean
  try {
    cleared = await taskRemove(id, deleteWorktree, projectId)
  } catch (e) {
    await refreshTasks(projectId).catch(() => {})
    throw e
  }
  // The removal succeeded; refreshing the lists must neither report it as failed nor skip the
  // cleanup after it.
  await refreshTasks(projectId).catch(() => {})
  // Also when the refresh failed and the list still holds it.
  forgetAutoDrafts(projectId, (task) => task === id)
  const state = useStore.getState().captureProjects()[projectId]?.state
  if (state?.activeTask === id) activateTaskIn(projectId, null)
  await reconcileFreshSessions().catch(() => {})
  if (!cleared)
    useStore
      .getState()
      .setMessage(
        deleteWorktree
          ? 'Worktree removed, but its sessions could not be cleared from Sessions.'
          : 'Worktree forgotten, but its sessions could not be cleared from Sessions.',
      )
}

/** How the open New worktree dialog was asked for. */
interface NewTaskSeed {
  /** The worktree's title to start from. */
  title?: string
  /** A new worktree (not an attached one) starts with a copy of the project plan. */
  copyPlan?: boolean
}
/** What to do with the worktree the open New worktree dialog makes, once it is active. */
let onNewTask: {
  then?: (task: Task, projectId: string) => void
  copyPlan: boolean
} | null = null
/** Close the dialog without leaving its follow-up attached to a later worktree. */
export function cancelNewTask() {
  onNewTask = null
  useStore.getState().setNewTask(null)
}

async function afterNewTask(task: Task, projectId: string, created: boolean) {
  const pending = onNewTask
  onNewTask = null
  if (!pending) return
  // Before the follow-up, so an Auto panel it opens already infers its goal from the copy.
  if (created && pending.copyPlan) await copyProjectPlan(projectId, task.id)
  pending.then?.(task, projectId)
}

/**
 * Give a new worktree the project plan as its own plan, which its agents and Auto read, when the
 * project plan is whole and nonempty and the worktree has none. The worktree exists already, so a
 * failed copy only says so.
 */
async function copyProjectPlan(projectId: string, task: string) {
  try {
    const { text, cut } = await planRead(projectId)
    if (!cut && text.trim()) await planWrite(projectId, task, text, '')
  } catch (e) {
    useStore
      .getState()
      .setMessage(
        `Worktree created, but the project plan could not be copied into it: ${String(e)}`,
      )
  }
}

/**
 * Open the new-worktree dialog for the highlighted components, else the selected one; `then` runs
 * once it has created or attached a worktree and made it active.
 */
export function seedNewTask(
  then?: (task: Task, projectId: string) => void,
  { title, copyPlan = false }: NewTaskSeed = {},
) {
  onNewTask = then || copyPlan ? { then, copyPlan } : null
  const s = useStore.getState()
  s.setNewTask({
    components: s.highlighted.length ? [...s.highlighted] : s.selectedId ? [s.selectedId] : [],
    title,
  })
}

/** A worktree title from a goal: its first nonempty line, without a heading mark, kept short. */
export function titleFor(goal: string, max = 72) {
  const line =
    goal
      .split('\n')
      .map((l) => l.replace(/^\s*#+\s*/, '').trim())
      .find(Boolean) ?? ''
  // Counted in code points, so a cut never splits an emoji's surrogate pair.
  const chars = Array.from(line)
  if (chars.length <= max) return line
  // At a word boundary, keeping a word the cut ends right after, unless that loses most of it.
  const words = chars
    .slice(0, max + 1)
    .join('')
    .replace(/\S*$/, '')
    .trimEnd()
  return Array.from(words).length >= max / 2 ? words : chars.slice(0, max).join('').trimEnd()
}

/** Branch names, and the worktree folders named after them, stay this short. */
const BRANCH_LIMIT = 60

/** A branch name from a title: `Fix login bug` → `fix-login-bug`. */
export function branchFor(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9/._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, BRANCH_LIMIT)
    .replace(/^[-./]+|[-./]+$/g, '')
}

export function applyTaskActivity(activity: import('../types').TaskActivity) {
  const s = useStore.getState()
  if (
    s.taskActivities[activity.id]?.state !== undefined &&
    s.taskActivities[activity.id].state !== 'running' &&
    activity.state === 'running'
  )
    return
  // Finishing in the worktree on screen, it is seen already.
  const onScreen = unseenFinished(activity, s.project?.id, s.activeTask, new Set(s.seenActivities))
  useStore.setState({
    taskActivities: { ...s.taskActivities, [activity.id]: activity },
    seenActivities: onScreen ? [...s.seenActivities, activity.id] : s.seenActivities,
  })
  s.patchTask(activity.projectId, activity.task, {
    ...taskActionState(useStore.getState().taskActivities, activity.projectId, activity.task),
    ...(activity.report ? { graphActionReport: activity.report } : {}),
  })
}
