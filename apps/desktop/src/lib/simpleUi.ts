import { create } from 'zustand'
import type { SimpleStage } from './simple'
import type { SessionState } from '../types'
import { sessionRun, type TerminalStatus } from './display'
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
  /** Input-driven expansion lasts through typing until the provider confirms a new state. */
  inputRequests: Record<string, string>
  diff: SimpleDiff | null
  /** The chat's stage tab: which sections the thread shows. */
  stageFilter: SimpleStage | 'all'
  /**
   * Explicit user choices under All, including choices matching the current default.
   * Without a choice, only the current stage opens.
   */
  stages: StageOverrides
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

/** A keystroke revokes hook authority; it does not confirm that an answer is complete. */
export function pendingInput(
  sid: string,
  session: SessionState | undefined,
  status: TerminalStatus,
  previous?: string,
): string | undefined {
  const run = sessionRun(sid, session)
  if (status.health === 'input') return run
  return previous === run &&
    session?.running &&
    !session.disconnected &&
    !session.interrupted &&
    !session.status?.agent?.authoritative
    ? run
    : undefined
}
export const emptySimpleUi = (): SimpleUi => ({
  draft: '',
  mentions: [],
  expanded: [],
  inputRequests: {},
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
  toggleStage: (key: string, stage: SimpleStage, current: SimpleStage, inputs?: string[]) => void
  syncInputRequests: (key: string, requests: Record<string, string>) => void
}>((set) => ({
  worktrees: {},
  patch: (key, patch) =>
    set((s) => ({
      worktrees: { ...s.worktrees, [key]: { ...emptySimpleUi(), ...s.worktrees[key], ...patch } },
    })),
  toggleStage: (key, stage, current, inputs = []) =>
    set((s) => {
      const ui = { ...emptySimpleUi(), ...s.worktrees[key] }
      return {
        worktrees: {
          ...s.worktrees,
          [key]: {
            ...ui,
            inputRequests: Object.fromEntries(
              Object.entries(ui.inputRequests).filter(([sid]) => !inputs.includes(sid)),
            ),
            stages: inputs.length
              ? { ...ui.stages, [stage]: false }
              : toggledStage(ui.stages, stage, current),
          },
        },
      }
    }),
  syncInputRequests: (key, requests) =>
    set((s) => {
      const ui = { ...emptySimpleUi(), ...s.worktrees[key] }
      if (
        Object.keys(ui.inputRequests).length === Object.keys(requests).length &&
        Object.entries(requests).every(([sid, run]) => ui.inputRequests[sid] === run)
      )
        return s
      return {
        worktrees: {
          ...s.worktrees,
          [key]: {
            ...ui,
            inputRequests: requests,
          },
        },
      }
    }),
}))
export const EMPTY_SIMPLE_UI = emptySimpleUi()
