import type { AgentRole, AutoRun, AutoStage, EffortSettings } from '../types'

/**
 * What the user gave the Auto dialog, kept while its popover is closed until a run starts. Only
 * the user's own choices are kept: what the dialog fills in itself is inferred again on reopen.
 */
export interface AutoDraft {
  /** The goal as the user typed it; absent, the dialog infers one. */
  goal?: string
  effort: AutoRun['effort']
  overrides: Partial<EffortSettings>
  mode: 'ask' | 'auto'
  /** The destination the user picked; absent, the dialog picks one. */
  destination?: string
  picked: Partial<Record<AgentRole, string>>
  reviewers?: string[]
  stage: AutoStage | ''
}

export const emptyAutoDraft = (): AutoDraft => ({
  effort: 'standard',
  overrides: {},
  mode: 'ask',
  picked: {},
  stage: '',
})

/** The draft to keep: an emptied or blank goal, or an emptied destination, is inferred again. */
export const savedAutoDraft = (draft: AutoDraft): AutoDraft => ({
  ...draft,
  goal: draft.goal?.trim() ? draft.goal : undefined,
  destination: draft.destination || undefined,
})

/** Drafts per project and worktree (UI only, like `planDrafts`). */
export const autoDrafts = new Map<string, AutoDraft>()

export const autoDraftKey = (projectId: string | undefined, task: string | null) =>
  JSON.stringify([projectId ?? '', task])

/** Drop a closed project's drafts, or with `task`, only that removed worktree's. */
export function forgetAutoDrafts(projectId: string, task?: string) {
  for (const key of autoDrafts.keys()) {
    const [p, t] = JSON.parse(key) as [string, string | null]
    if (p === projectId && (task === undefined || t === task)) autoDrafts.delete(key)
  }
}

/** Drop the drafts of a project's worktrees its task list no longer holds, however they went. */
export function pruneAutoDrafts(projectId: string, tasks: readonly string[]) {
  const known = new Set(tasks)
  for (const key of autoDrafts.keys()) {
    const [p, t] = JSON.parse(key) as [string, string | null]
    if (p === projectId && t !== null && !known.has(t)) autoDrafts.delete(key)
  }
}
