import {
  AGENT_ROLES,
  type AgentRole,
  type AutoStage,
  type AutoRun,
  type EffortSettings,
} from '../types'

/**
 * What the user gave the Auto dialog, kept while its popover is closed until a run starts. Only
 * the user's own choices are kept: what the dialog fills in itself is inferred again on reopen.
 */
export interface AutoDraft {
  /** A stopped run whose replacement setup should stay open across panel mounts. */
  replacementFor?: string
  replacementEffort?: AutoRun['effort']
  cleanup?: AutoRun['merge']['cleanup']
  /** Story to link once this draft successfully starts a run. */
  story?: string
  autonomous?: boolean
  background?: boolean
  resumeOnUsageReset?: boolean
  /** The goal as the user typed it; absent, the dialog infers one. */
  goal?: string
  /** The goal Chat wrote at its last handoff; while `goal` still equals it, Chat rewrites it. */
  chatGoal?: string
  overrides: Partial<EffortSettings>
  mode: 'ask' | 'auto'
  /** The destination the user picked; absent, the dialog picks one. */
  destination?: string
  picked: Partial<Record<AgentRole, string>>
  reviewers?: string[]
  scanners?: string[]
  workers?: string[]
  stage: AutoStage | ''
}

export const emptyAutoDraft = (): AutoDraft => ({
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

/** Drop a project's drafts, all of them when it closes, else the worktrees' that `drop` picks. */
export function forgetAutoDrafts(
  projectId: string,
  drop: (task: string | null) => boolean = () => true,
) {
  for (const key of autoDrafts.keys()) {
    const [p, t] = JSON.parse(key) as [string, string | null]
    if (p === projectId && drop(t)) autoDrafts.delete(key)
  }
}

/** Carry forward configuration only. The new run starts with a fresh budget and stage detection. */
export function replacementAutoDraft(run: AutoRun, stoppedRunId: string): AutoDraft {
  return {
    ...emptyAutoDraft(),
    replacementFor: stoppedRunId,
    replacementEffort: run.effort,
    goal: run.goal,
    overrides: run.overrides ?? {},
    mode: run.merge.mode,
    cleanup: run.merge.cleanup,
    destination: run.merge.destinationBranch || undefined,
    picked: Object.fromEntries(AGENT_ROLES.map((role) => [role, run.agents?.[role] ?? run.device])),
    reviewers: run.reviewers ?? [run.agents?.review ?? run.device],
    scanners: run.scanners ?? [],
    workers: run.workers ?? [],
    autonomous: run.autonomous,
    background: run.background,
    resumeOnUsageReset: run.resumeOnUsageReset,
  }
}
