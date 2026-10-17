import type { AgentRole, AutoRun, AutoStage, EffortSettings } from '../types'

/** What the Auto dialog was given, kept while its popover is closed until a run starts. */
export interface AutoDraft {
  goal: string
  /** The goal the dialog filled in itself, withdrawn once a load finds the branch merged. */
  filledGoal: string
  effort: AutoRun['effort']
  overrides: Partial<EffortSettings>
  mode: 'ask' | 'auto'
  destination: string
  picked: Partial<Record<AgentRole, string>>
  reviewers?: string[]
  stage: AutoStage | ''
}

/** Drafts per project and worktree (UI only, like `planDrafts`). */
export const autoDrafts = new Map<string, AutoDraft>()

export const autoDraftKey = (projectId: string | undefined, task: string | null) =>
  JSON.stringify([projectId ?? '', task])
