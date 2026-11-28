import { projectStateOf } from '../store'
import type { Task } from '../types'

/**
 * Where work ran, for a result the lead relays: it works in several worktrees, so each result
 * names its worktree and branch. Empty in the project folder.
 */
export function stageWhere(target: { projectId: string; task: string | null }) {
  if (!target.task) return ''
  const task = projectStateOf(target.projectId)?.tasks?.find((t) => t.id === target.task)
  if (!task) return ` in worktree ${target.task}`
  return ` in worktree ${task.id} “${task.title}”${task.branch ? ` (branch ${task.branch})` : ''}`
}

/** A worktree's short name for chips and cards: its title, else the project folder. */
export function worktreeName(task: Pick<Task, 'title'> | undefined) {
  return task?.title ?? 'Project folder'
}

/** `title · branch`, the label that tells the user which worktree an agent or result is in. */
export function worktreeChip(
  tasks: readonly Pick<Task, 'id' | 'title' | 'branch'>[],
  task: string | null | undefined,
  projectBranch?: string | null,
) {
  const found = task ? tasks.find((t) => t.id === task) : undefined
  const branch = task ? found?.branch : projectBranch
  return {
    name: task ? (found?.title ?? task) : 'Project folder',
    branch: branch ?? undefined,
    label: `${task ? (found?.title ?? task) : 'Project folder'}${branch ? ` · ${branch}` : ''}`,
  }
}
