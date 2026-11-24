import { projectStateOf, useStore } from '../store'
import type { DeviceManifest, Project, ReviewRequest, SessionRecord, Worktree } from '../types'
import { gitWorktrees, reviewFixTask } from './ipc'
import { implementPlannerPlan, type HandoffTarget } from './planHandoff'
import { startMerge, type MergeOptions } from './reviewAgents'
import { fixReviewFindings } from './reviewHandoff'
import { startSimpleReview } from './simpleReview'
import { recordStageLaunch, refuseWhileAutoRuns, type StageLaunch } from './stageRecord'

/** The agent already runs, so a failure to record it never reports the launch as failed. */
const recordQuietly = (launch: StageLaunch) => recordStageLaunch(launch).catch(() => {})

/** Build the saved plan, from Chat's Build or the Plan view's Implement. */
export async function launchBuild(
  origin: 'chat' | 'manual',
  planner: string,
  projectId: string,
  task: string | null,
  presentation: 'stay' | 'follow',
  target?: HandoffTarget,
) {
  refuseWhileAutoRuns(projectId, task)
  const launched = await implementPlannerPlan(planner, undefined, undefined, presentation, target)
  await recordQuietly({ projectId, task, origin, action: 'implement', launched: [launched] })
  return launched
}

/** Fix a review's findings in its worktree, from Chat's Fix or the findings' Fix in Build. */
export async function launchFix(
  origin: 'chat' | 'manual',
  reviewer: SessionRecord,
  presentation: 'stay' | 'follow',
  target?: HandoffTarget,
) {
  // The backend names the reviewed worktree's task, whatever form its path takes.
  refuseWhileAutoRuns(
    reviewer.metadata.projectId,
    target ? target.task : await reviewFixTask(reviewer.id, reviewer.metadata.projectId),
  )
  const fixing = await fixReviewFindings(reviewer, undefined, undefined, presentation, target)
  await recordQuietly({
    projectId: reviewer.metadata.projectId,
    task: fixing.task,
    origin,
    action: 'fix',
    launched: [fixing],
  })
  return fixing
}

/**
 * Review a worktree with the review role's presets, replacing reviewers that settled. Every
 * reviewer that starts is recorded; the others' errors are returned.
 */
export async function launchReview(
  origin: 'chat' | 'manual',
  project: Project,
  /** `undefined` for a worktree without a chat: the review runs, unrecorded. */
  task: string | null | undefined,
  request: ReviewRequest,
  devices: DeviceManifest[],
) {
  refuseWhileAutoRuns(project.projectId!, task)
  const result = await startSimpleReview(project, request, devices)
  if (task === undefined) return result
  await recordQuietly({
    projectId: project.projectId!,
    task,
    origin,
    action: 'review',
    launched: result.started,
    what: `a review of ${request.branch}`,
  })
  return result
}

/**
 * Merge from Chat or the Review view through the shared preflight. Only a merge that started is
 * recorded; conflicts and uncommitted changes come back for the caller to show.
 */
export async function launchMerge(
  origin: 'chat' | 'manual',
  /** `undefined` for a source worktree without a chat: the merge runs, unrecorded. */
  task: string | null | undefined,
  options: Extract<MergeOptions, { source: unknown }>,
) {
  const projectId = options.project.projectId!
  refuseWhileAutoRuns(projectId, task)
  // The merge agent works in the destination, which Auto may own too.
  const destination = (await gitWorktrees(projectId)).find(
    (w) => w.branch === options.destinationBranch,
  )
  if (destination) refuseWhileAutoRuns(projectId, taskOfWorktree(destination, projectId))
  // Checked again after the worktree read, in case Auto started or resumed meanwhile.
  refuseWhileAutoRuns(projectId, task)
  const started = await startMerge(options)
  if (started.kind === 'started' && task !== undefined)
    await recordQuietly({
      projectId: options.project.projectId!,
      task,
      origin,
      action: 'merge',
      launched: [started],
      request: started.request,
      what: `a merge of ${started.request.sourceBranch} into ${started.request.destinationBranch}`,
    })
  return started
}

/**
 * The task whose worktree this is: `null` for the project folder (git's main worktree), and
 * `undefined` for a worktree Patchbay doesn't know (one created outside it), which has no chat.
 */
export function taskOfWorktree(
  worktree: Pick<Worktree, 'path'> & Partial<Pick<Worktree, 'main'>>,
  projectId = useStore.getState().project?.id,
): string | null | undefined {
  // The launching project's tasks, even if another project's tab is now shown.
  const state = projectId ? projectStateOf(projectId) : undefined
  // The project folder may itself be attached as a task, whose chat is then the task's.
  const task = state?.tasks.find((t) => !t.missing && t.worktree === worktree.path)
  if (task) return task.id
  return worktree.main || worktree.path === state?.project?.root ? null : undefined
}
