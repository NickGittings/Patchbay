import { create } from 'zustand'
import type { SimpleStage } from './simple'
export interface Mention {
  id: string
  token: string
  start: number
  end: number
}
export interface SimpleDiff {
  componentId: string
  path: string
  line?: number
}
export interface SimpleUi {
  draft: string
  mentions: Mention[]
  recipient?: string
  expanded: string[]
  diff: SimpleDiff | null
  /** The chat's stage tab: which sections the thread shows. */
  stageFilter: SimpleStage | 'all'
  /**
   * Stages the user opened (true) or collapsed (false) under All, unlike their default: only the
   * thread's current stage and stages in use are open. Kept across stage changes.
   */
  stages: StageOverrides
}
export type StageOverrides = Partial<Record<SimpleStage, boolean>>
/** User choices win; otherwise keep the current stage and any stage in use open. */
export const stageOpen = (
  overrides: StageOverrides,
  stage: SimpleStage,
  current: SimpleStage,
  inUse = false,
) => overrides[stage] ?? (stage === current || inUse)
/**
 * The overrides after toggling a stage as shown. Choosing its default again forgets the choice,
 * so the stage follows the current stage again.
 */
export function toggledStage(
  overrides: StageOverrides,
  stage: SimpleStage,
  current: SimpleStage,
  inUse = false,
): StageOverrides {
  const open = !stageOpen(overrides, stage, current, inUse)
  const next = { ...overrides }
  if (open === (stage === current || inUse)) delete next[stage]
  else next[stage] = open
  return next
}
export const emptySimpleUi = (): SimpleUi => ({
  draft: '',
  mentions: [],
  expanded: [],
  diff: null,
  stageFilter: 'all',
  stages: {},
})
export const simpleKey = (projectId: string | undefined, task: string | null) =>
  JSON.stringify([projectId ?? '', task])
export const useSimpleUi = create<{
  worktrees: Record<string, SimpleUi>
  patch: (key: string, patch: Partial<SimpleUi>) => void
  /** Toggles a stage against the latest overrides, so quick clicks never undo each other. */
  toggleStage: (key: string, stage: SimpleStage, current: SimpleStage, inUse?: boolean) => void
}>((set) => ({
  worktrees: {},
  patch: (key, patch) =>
    set((s) => ({
      worktrees: { ...s.worktrees, [key]: { ...emptySimpleUi(), ...s.worktrees[key], ...patch } },
    })),
  toggleStage: (key, stage, current, inUse) =>
    set((s) => {
      const ui = { ...emptySimpleUi(), ...s.worktrees[key] }
      return {
        worktrees: {
          ...s.worktrees,
          [key]: { ...ui, stages: toggledStage(ui.stages, stage, current, inUse) },
        },
      }
    }),
}))
export const EMPTY_SIMPLE_UI = emptySimpleUi()
