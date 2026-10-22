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
}
export const emptySimpleUi = (): SimpleUi => ({
  draft: '',
  mentions: [],
  expanded: [],
  diff: null,
  stageFilter: 'all',
})
export const simpleKey = (projectId: string | undefined, task: string | null) =>
  JSON.stringify([projectId ?? '', task])
export const useSimpleUi = create<{
  worktrees: Record<string, SimpleUi>
  patch: (key: string, patch: Partial<SimpleUi>) => void
}>((set) => ({
  worktrees: {},
  patch: (key, patch) =>
    set((s) => ({
      worktrees: { ...s.worktrees, [key]: { ...emptySimpleUi(), ...s.worktrees[key], ...patch } },
    })),
}))
export const EMPTY_SIMPLE_UI = emptySimpleUi()

/** Transient activity pulses for the currently visible Simple map. */
export const useSimpleMap = create<{ active: string[] }>(() => ({ active: [] }))
