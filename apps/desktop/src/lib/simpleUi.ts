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
  /** Input-driven expansion: the request's run, kept while an answer is being typed. */
  inputRequests: Record<string, string>
  /** Cards folded while their input expansion lasts; their stage stays open and shown. */
  inputCollapsed: string[]
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
/**
 * User choices win; otherwise the current stage opens, as does a stage in use (holding focus or
 * an open inline terminal), so an advance never folds a stage out from under the user.
 */
export const stageOpen = (
  overrides: StageOverrides,
  stage: SimpleStage,
  current: SimpleStage,
  inUse = false,
) => overrides[stage] ?? (stage === current || inUse)

/** Every toggle saves the user's choice, including reopening the current stage. */
export function toggledStage(
  overrides: StageOverrides,
  stage: SimpleStage,
  current: SimpleStage,
  inUse = false,
): StageOverrides {
  return { ...overrides, [stage]: !stageOpen(overrides, stage, current, inUse) }
}

/**
 * An input request's expansion lasts through the answer: typing turns `needsInput` into
 * unconfirmed `working`, which decays to idle once quiet. Any other state ends it: a confirmed
 * provider state, Esc or an interrupt (unconfirmed `idle`), a status-file report of its own
 * (never authoritative) once it moves on from working, an exit or a new run.
 */
export function pendingInput(
  sid: string,
  session: SessionState | undefined,
  status: TerminalStatus,
  previous?: string,
): string | undefined {
  const run = sessionRun(sid, session)
  if (status.health === 'input') return run
  const agent = session?.status?.agent
  return previous === run &&
    session?.running &&
    !session.disconnected &&
    !session.interrupted &&
    agent?.state === 'working' &&
    !agent.authoritative
    ? run
    : undefined
}
const without = (list: string[], ids: string[]) => list.filter((id) => !ids.includes(id))
export const emptySimpleUi = (): SimpleUi => ({
  draft: '',
  mentions: [],
  expanded: [],
  inputRequests: {},
  inputCollapsed: [],
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
  toggleStage: (
    key: string,
    stage: SimpleStage,
    current: SimpleStage,
    options?: { inputs?: string[]; inUse?: boolean },
  ) => void
  /** Folds or unfolds an agent card without touching its stage's input expansion. */
  toggleAgent: (key: string, sid: string, expanded: boolean, inputOpen: boolean) => void
  /** Keeps the input expansions shown; a card asking anew unfolds again. */
  syncInputRequests: (key: string, requests: Record<string, string>, asking: string[]) => void
}>((set) => ({
  worktrees: {},
  patch: (key, patch) =>
    set((s) => ({
      worktrees: { ...s.worktrees, [key]: { ...emptySimpleUi(), ...s.worktrees[key], ...patch } },
    })),
  toggleStage: (key, stage, current, { inputs = [], inUse = false } = {}) =>
    set((s) => {
      const ui = { ...emptySimpleUi(), ...s.worktrees[key] }
      return {
        worktrees: {
          ...s.worktrees,
          [key]: {
            ...ui,
            // Collapsing a stage held open by input requests dismisses them.
            inputRequests: Object.fromEntries(
              Object.entries(ui.inputRequests).filter(([sid]) => !inputs.includes(sid)),
            ),
            inputCollapsed: without(ui.inputCollapsed, inputs),
            stages: inputs.length
              ? { ...ui.stages, [stage]: false }
              : toggledStage(ui.stages, stage, current, inUse),
          },
        },
      }
    }),
  toggleAgent: (key, sid, expanded, inputOpen) =>
    set((s) => {
      const ui = { ...emptySimpleUi(), ...s.worktrees[key] }
      const expandedList = without(ui.expanded, [sid]),
        collapsed = without(ui.inputCollapsed, [sid])
      return {
        worktrees: {
          ...s.worktrees,
          [key]: {
            ...ui,
            expanded: expanded ? expandedList : [...expandedList, sid],
            inputCollapsed: expanded && inputOpen ? [...collapsed, sid] : collapsed,
          },
        },
      }
    }),
  syncInputRequests: (key, requests, asking) =>
    set((s) => {
      const ui = { ...emptySimpleUi(), ...s.worktrees[key] }
      const collapsed = ui.inputCollapsed.filter((sid) => sid in requests && !asking.includes(sid))
      if (
        collapsed.length === ui.inputCollapsed.length &&
        Object.keys(ui.inputRequests).length === Object.keys(requests).length &&
        Object.entries(requests).every(([sid, run]) => ui.inputRequests[sid] === run)
      )
        return s
      return {
        worktrees: {
          ...s.worktrees,
          [key]: { ...ui, inputRequests: requests, inputCollapsed: collapsed },
        },
      }
    }),
}))
export const EMPTY_SIMPLE_UI = emptySimpleUi()
