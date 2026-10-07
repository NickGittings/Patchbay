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
      ['environmentStart', 'validate'].includes(a.action.kind),
  )
  return {
    graphActionBusy: !!running,
    graphAction:
      running?.action.kind === 'environmentStart'
        ? { kind: 'startGroup', groupId: running.action.groupId! }
        : running?.action.kind === 'validate'
          ? { kind: 'validateAffected', componentId: running.action.componentId! }
          : null,
  }
}
