import { projectStateOf, useStore, workspaceOf } from '../store'
import type { AutoRun, View } from '../types'

export interface WorkTarget {
  projectId: string
  task: string | null
}

export function worktreeIdentity({ projectId, task }: WorkTarget) {
  const project = projectStateOf(projectId)
  const tree = project?.tasks.find((t) => t.id === task && !t.missing)
  return task === null
    ? project?.project?.root
    : tree && JSON.stringify([tree.worktree, tree.branch])
}

export type WorkRecovery =
  | { kind: 'auto'; target: WorkTarget; returnAfterStop?: boolean }
  | { kind: 'refreshLead'; projectId: string }
  | { kind: 'failedWorker'; assignment: string; name: string; target: WorkTarget }

export class WorkBlocker extends Error {
  readonly recovery?: WorkRecovery

  constructor(message: string, recovery?: WorkRecovery) {
    super(message)
    this.recovery = recovery
  }
}

export const workError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error))

export function worktreeLabel({ projectId, task }: WorkTarget) {
  const state = projectStateOf(projectId)
  const tree = state?.tasks.find((t) => t.id === task)
  return tree ? (tree.branch ?? tree.title) : 'the project folder'
}

export function autoBlocker(projectId: string | undefined, task: string | null | undefined) {
  const state = projectId && projectStateOf(projectId)
  if (!projectId || !state || task === undefined) return
  const run = workspaceOf(state, task).auto
  const target = { projectId, task }
  // A Stop in progress, or one that failed, may leave Auto's agents running in the worktree.
  if (run?.stopPending)
    return new WorkBlocker(
      `Auto is still stopping in ${worktreeLabel(target)}. Open the run to finish stopping it.`,
      { kind: 'auto', target, returnAfterStop: true },
    )
  const status = run?.status
  if (status !== 'running' && status !== 'waitingOnYou') return
  const activity = status === 'running' ? 'is running' : 'is waiting for input'
  return new WorkBlocker(
    `Auto ${activity} in ${worktreeLabel(target)}. Open the run to continue, pause, or stop it.`,
    { kind: 'auto', target, returnAfterStop: true },
  )
}

export function refuseWhileAutoRuns(projectId: string, task: string | null | undefined) {
  const blocker = autoBlocker(projectId, task)
  if (blocker) throw blocker
}

let returnAfterAuto:
  { runId: string; origin: WorkTarget; target: WorkTarget; view: View; chat: boolean } | undefined

let stopWatching: (() => void) | undefined
/** The return route lasts only while the user stays in that worktree's Auto panel. */
function forgetReturnOnLeave(back: NonNullable<typeof returnAfterAuto>) {
  stopWatching?.()
  const unsubscribe = useStore.subscribe((state) => {
    if (
      returnAfterAuto === back &&
      state.utilityPanel === 'auto' &&
      state.project?.id === back.target.projectId &&
      state.activeTask === back.target.task
    )
      return
    if (returnAfterAuto === back) returnAfterAuto = undefined
    unsubscribe()
    if (stopWatching === unsubscribe) stopWatching = undefined
  })
  stopWatching = unsubscribe
}

export function openWorktreeAuto({ projectId, task }: WorkTarget, fromStage = false) {
  const state = useStore.getState()
  const project = projectStateOf(projectId, state)
  if (!project || (task !== null && !project.tasks.some((t) => t.id === task && !t.missing)))
    throw new Error(
      'That worktree is no longer available. Refresh the worktree list and try again.',
    )
  const run = workspaceOf(project, task).auto
  const origin = state.project && { projectId: state.project.id, task: state.activeTask }
  if (fromStage && run && origin)
    returnAfterAuto = {
      runId: run.ownershipId ?? run.runId,
      origin,
      target: { projectId, task },
      view: state.view,
      chat: state.simpleMode,
    }
  if (state.project?.id !== projectId) state.activateProject(projectId)
  useStore.getState().setActiveTask(task, true)
  const current = useStore.getState()
  if (current.project?.id !== projectId || current.activeTask !== task)
    throw new Error('Could not open that worktree. Select it in Worktrees and try again.')
  current.showAutoPanel()
  if (returnAfterAuto) forgetReturnOnLeave(returnAfterAuto)
  if (typeof document !== 'undefined')
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.utility-panel[data-panel="auto"] h2')?.focus()
    })
}

/** A direct Stop from stage recovery returns to the original stage without launching it. */
export function returnAfterAutoStop(target: WorkTarget, stopped: AutoRun) {
  const back = returnAfterAuto
  if (
    back?.runId !== (stopped.ownershipId ?? stopped.runId) ||
    back.target.projectId !== target.projectId ||
    back.target.task !== target.task
  )
    return
  returnAfterAuto = undefined
  const state = useStore.getState()
  if (
    state.project?.id !== target.projectId ||
    state.activeTask !== target.task ||
    state.view !== back.view ||
    state.simpleMode !== back.chat ||
    !worktreeIdentity(back.origin)
  )
    return
  if (back.origin.projectId !== target.projectId) state.activateProject(back.origin.projectId)
  useStore.getState().setActiveTask(back.origin.task, true)
  useStore.setState({ utilityPanel: null })
  if (typeof document !== 'undefined')
    requestAnimationFrame(() => {
      const control = back.chat
        ? '.simple-step-actions button'
        : back.view === 'review'
          ? '.review-merge-button'
          : '.plan-implement button'
      const fallback = back.chat
        ? '.simple-chat header button'
        : '.workspace-rail [aria-label="Auto mode"]'
      const element =
        document.querySelector<HTMLButtonElement>(`${control}:not(:disabled)`) ??
        document.querySelector<HTMLButtonElement>(fallback)
      element?.focus()
    })
}
