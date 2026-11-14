import type { Worktree } from '../types'
import { gitBranchAction, type BranchAction } from './ipc'

/** Both branch controls share the same confirmation and retain the selected checkout identity. */
export async function changeBranch(
  projectId: string,
  current: Worktree,
  action: BranchAction,
): Promise<boolean> {
  const apply = (stopSessions = false) =>
    gitBranchAction(projectId, current.head, current.branch, action, current.path, stopSessions)
  if ((await apply()) === 'applied') return true
  const verb = action.kind === 'rename' ? 'rename this branch to' : 'switch to'
  if (
    !window.confirm(
      `Stop terminals and agents in this worktree and ${verb} “${action.branch}”?\n\n${current.path}\n\nRunning work will be interrupted. Terminal history will be kept.`,
    )
  )
    return false
  if ((await apply(true)) !== 'applied')
    throw new Error('Terminals or agents are still running; try changing the branch again')
  return true
}
