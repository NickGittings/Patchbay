import type { useStore } from '../store'

type State = ReturnType<typeof useStore.getState>

/**
 * Chat's one conversation lives in the project folder (`LEAD_HOME_TASK` in `chatTeams`). The
 * worktree picker only moves the focus, so these read a worktree's saved state wherever the
 * focus is.
 */
export const simpleOf = (s: State, task: string | null) =>
  s.activeTask === task ? s.simple : (s.taskWorkspaces[task ?? '']?.simple ?? null)

export const autoOf = (s: State, task: string | null) =>
  s.activeTask === task ? s.auto : (s.taskWorkspaces[task ?? '']?.auto ?? null)
