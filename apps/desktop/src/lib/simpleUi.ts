import { create } from 'zustand'
import type { SessionRecord, SessionState } from '../types'
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
  diff: SimpleDiff | null
  terminal: 'closed' | 'user' | 'input'
  terminalSession?: { id: string; generation?: number; pinned?: boolean }
  inputRequest?: string
}

/** Typing only guesses that work resumed. Keep the question's terminal until hooks confirm it. */
export function inputDrawer(
  ui: SimpleUi,
  asking: SessionRecord | undefined,
  sessions: Record<string, SessionState>,
): SimpleUi {
  // View explicitly selects a terminal, including settled runs, until the user hides it.
  if (ui.terminal === 'user' && ui.terminalSession?.pinned) return ui
  if (ui.terminal !== 'closed' && ui.terminalSession) {
    const session = sessions[ui.terminalSession.id]
    if (
      session?.running &&
      session.generation === ui.terminalSession.generation &&
      !session.status?.stopped &&
      (session.status?.agent?.state === 'needsInput' || !session.status?.agent?.authoritative)
    )
      return ui
  }
  const session = asking && sessions[asking.id]
  const request = asking && `${asking.id}:${session?.generation}:${session?.status?.agent?.sinceMs}`
  if (asking && request !== ui.inputRequest) {
    return {
      ...ui,
      inputRequest: request,
      terminal: ui.terminal === 'user' ? 'user' : 'input',
      terminalSession: { id: asking.id, generation: session?.generation },
    }
  }
  if (ui.terminal === 'input') return { ...ui, terminal: 'closed', terminalSession: undefined }
  return ui.terminalSession ? { ...ui, terminalSession: undefined } : ui
}
export const emptySimpleUi = (): SimpleUi => ({
  draft: '',
  mentions: [],
  diff: null,
  terminal: 'closed',
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
