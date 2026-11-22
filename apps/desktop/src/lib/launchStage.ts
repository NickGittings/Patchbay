import { useStore } from '../store'
import type { DeviceManifest, Project, ReviewRequest, SessionRecord } from '../types'
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
  refuseWhileAutoRuns(
    reviewer.metadata.projectId,
    target?.task ?? taskOfWorktree(reviewer.spec.cwd),
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
  refuseWhileAutoRuns(options.project.projectId!, task)
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
 * The task whose worktree is `path`: `null` for the project folder, `undefined` for a worktree
 * Patchbay doesn't know (one created outside it), which has no chat to record in.
 */
export function taskOfWorktree(path: string): string | null | undefined {
  const s = useStore.getState()
  // The project folder may itself be attached as a task, whose chat is then the task's.
  const task = s.tasks.find((t) => !t.missing && t.worktree === path)
  if (task) return task.id
  return path === s.project?.root ? null : undefined
}
