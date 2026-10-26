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
   * Saved stage choices under All. Only the current stage opens by default; an open current
   * stage is saved when the thread moves on, so its content stays in place.
   */
  stages: StageOverrides
  currentStage?: SimpleStage
}
export type StageOverrides = Partial<Record<SimpleStage, boolean>>
/** User choices win; otherwise only the current stage opens. */
export const stageOpen = (overrides: StageOverrides, stage: SimpleStage, current: SimpleStage) =>
  overrides[stage] ?? stage === current

/** Every toggle saves the user's choice, including reopening the current stage. */
export function toggledStage(
  overrides: StageOverrides,
  stage: SimpleStage,
  current: SimpleStage,
): StageOverrides {
  return { ...overrides, [stage]: !stageOpen(overrides, stage, current) }
}

/** Preserve the previous current stage if it was open when the thread moved on. */
export function stagesAfterAdvance(
  overrides: StageOverrides,
  previous: SimpleStage | undefined,
  current: SimpleStage,
): StageOverrides {
  return previous && previous !== current && stageOpen(overrides, previous, previous)
    ? { ...overrides, [previous]: true }
    : overrides
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
  syncStage: (key: string, current: SimpleStage) => void
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
          [key]: {
            ...ui,
            currentStage: current,
            stages: toggledStage(
              stagesAfterAdvance(ui.stages, ui.currentStage, current),
              stage,
              current,
            ),
          },
        },
      }
    }),
  syncStage: (key, current) =>
    set((s) => {
      const ui = { ...emptySimpleUi(), ...s.worktrees[key] }
      if (ui.currentStage === current) return s
      return {
        worktrees: {
          ...s.worktrees,
          [key]: {
            ...ui,
            currentStage: current,
            stages: stagesAfterAdvance(ui.stages, ui.currentStage, current),
          },
        },
      }
    }),
}))
export const EMPTY_SIMPLE_UI = emptySimpleUi()
