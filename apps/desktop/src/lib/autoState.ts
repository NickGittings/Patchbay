import type { AutoRun } from '../types'
import type { TaskWorkspace } from '../store'

/** Active workspaces live at the top level; the saved copy can be stale. */
type AutoState = {
  activeTask?: string | null
  auto?: AutoRun | null
  taskWorkspaces?: Record<string, TaskWorkspace>
}

export function autoWorkspace<T extends AutoState>(state: T | undefined, task: string | null) {
  return (state?.activeTask ?? null) === task ? state : state?.taskWorkspaces?.[task ?? '']
}

/** Include restored runs even before the task list has loaded. */
export function autoRuns(state: AutoState) {
  return [
    state.activeTask ?? null,
    ...Object.keys(state.taskWorkspaces ?? {}).map((id) => id || null),
  ]
    .filter((task, index, tasks) => tasks.indexOf(task) === index)
    .flatMap((task) => {
      const run = autoWorkspace(state, task)?.auto
      return run ? [{ task, run }] : []
    })
}
