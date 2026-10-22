import type { TaskWorkspace } from '../store'
import type { TaskActivity } from '../types'

/** A rejected competing request never clears the request still running in this task. */
export function taskActionState(
  activities: Record<string, TaskActivity>,
  projectId: string,
  task: string | null,
): Pick<TaskWorkspace, 'graphActionBusy' | 'graphAction'> {
  const running = Object.values(activities).find(
    (a) =>
      a.projectId === projectId &&
      a.task === task &&
      a.state === 'running' &&
      ['environmentStart', 'validate', 'validateChanged'].includes(a.action.kind),
  )
  return {
    graphActionBusy: !!running,
    graphAction:
      running?.action.kind === 'environmentStart'
        ? { kind: 'startGroup', groupId: running.action.groupId! }
        : running?.action.kind === 'validate'
          ? { kind: 'validateAffected', componentId: running.action.componentId! }
          : running?.action.kind === 'validateChanged'
            ? { kind: 'validateChanged', componentIds: running.action.componentIds! }
            : null,
  }
}

/**
 * Whether `activity` is a finished graph action of `projectId`'s `task` worktree that the user
 * hasn't seen yet.
 */
export function unseenFinished(
  activity: TaskActivity,
  projectId: string | undefined,
  task: string | null,
  seen: ReadonlySet<string>,
): boolean {
  return (
    activity.projectId === projectId &&
    (activity.task ?? null) === task &&
    activity.state !== 'running' &&
    !seen.has(activity.id)
  )
}
