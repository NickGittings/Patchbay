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
   * thread's current stage is open. Kept across stage changes, so Auto moving on keeps them.
   */
  stages: StageOverrides
}
export type StageOverrides = Partial<Record<SimpleStage, boolean>>
/** Whether a stage is open under All: the user's choice, else open only while current. */
export const stageOpen = (overrides: StageOverrides, stage: SimpleStage, current: SimpleStage) =>
  overrides[stage] ?? stage === current
/**
 * The overrides after toggling a stage as shown. Choosing its default again forgets the choice,
 * so the stage follows the current stage again.
 */
export function toggledStage(
  overrides: StageOverrides,
  stage: SimpleStage,
  current: SimpleStage,
): StageOverrides {
  const open = !stageOpen(overrides, stage, current)
  const next = { ...overrides }
  if (open === (stage === current)) delete next[stage]
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
  toggleStage: (key: string, stage: SimpleStage, current: SimpleStage) => void
}>((set) => ({
  worktrees: {},
  patch: (key, patch) =>
    set((s) => ({
      worktrees: { ...s.worktrees, [key]: { ...emptySimpleUi(), ...s.worktrees[key], ...patch } },
    })),
  toggleStage: (key, stage, current) =>
    set((s) => {
      const ui = { ...emptySimpleUi(), ...s.worktrees[key] }
      return {
        worktrees: {
          ...s.worktrees,
          [key]: { ...ui, stages: toggledStage(ui.stages, stage, current) },
        },
      }
    }),
}))
export const EMPTY_SIMPLE_UI = emptySimpleUi()
