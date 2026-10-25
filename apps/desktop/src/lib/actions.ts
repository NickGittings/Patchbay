import { taskActionState } from './taskActions'
import { useStore } from '../store'
import type { ActionReport, ActionRequest, Project } from '../types'
import { graphActionRun, graphGroupStop, graphValidationCancel } from './ipc'
import { refreshSession, listenForTerminals } from './sessions'

/**
 * Run `request` in `task`'s worktree of `projectId` (`null` for its own), keeping the busy state
 * and report in that worktree. Rejects when the action can't run.
 */
export async function graphActionIn(
  projectId: string,
  task: string | null,
  project: Project,
  request: ActionRequest,
): Promise<ActionReport> {
  const patch = (change: Parameters<ReturnType<typeof useStore.getState>['patchTask']>[2]) =>
    useStore.getState().patchTask(projectId, task, change)
  patch({ graphActionBusy: true, graphAction: request, graphActionReport: null })
  try {
    await listenForTerminals()
    const report = await graphActionRun(project, request, task ?? undefined)
    patch({ graphActionReport: report })
    // Already-running terminals may predate this window's listener.
    await Promise.all(report.results.map((r) => refreshSession(r.sessionId)))
    return report
  } finally {
    patch(taskActionState(useStore.getState().taskActivities, projectId, task))
  }
}

/**
 * Runs in the active task's worktree, like every other terminal list. The result lands in the
 * project it ran for, even if another tab is active by then; messages only show while it is.
 */
export async function runGraphAction(request: ActionRequest) {
  const s = useStore.getState()
  if (s.graphActionBusy || !s.project) return
  const projectId = s.project.id
  const project = s.toProject()
  const task = s.activeTask ?? undefined
  const say = (message: string) => {
    if (
      useStore.getState().project?.id === projectId &&
      useStore.getState().activeTask === (task ?? null)
    )
      useStore.getState().setMessage(message)
  }
  say(request.kind === 'startGroup' ? 'Starting stack…' : 'Validating affected components…')
  try {
    const report = await graphActionIn(projectId, task ?? null, project, request)
    const count = (outcome: string) => report.results.filter((r) => r.outcome === outcome).length
    const failed = count('failed')
    const stopped = count('stopped') + count('cancelled')
    say(
      `${report.results.length} task(s), ${failed} failed${stopped ? `, ${stopped} stopped or not run` : ''}, ${report.plan.skipped.length} component(s) without configured tasks`,
    )
  } catch (e) {
    say(String(e))
  }
}

/**
 * Stops the group's environment in the active task's worktree, or with `everywhere`
 * in the project's own worktree and every task's (before deleting the group).
 */
export async function stopGroup(groupId: string, everywhere = false) {
  const { project, activeTask, tasks } = useStore.getState()
  if (!project) return false
  const targets = everywhere ? [null, ...tasks.map((t) => t.id)] : [activeTask]
  const say = (message: string) => {
    if (useStore.getState().project?.id === project.id) useStore.getState().setMessage(message)
  }
  try {
    for (const task of targets) await graphGroupStop(groupId, task ?? undefined, project.id)
    say('Stack stopped')
    return true
  } catch (e) {
    say(String(e))
    return false
  }
}

/** Stops the running validation; its report keeps the validators that already ran. */
export async function stopValidation() {
  try {
    await graphValidationCancel(useStore.getState().project?.id)
  } catch (e) {
    useStore.getState().setMessage(String(e))
  }
}
