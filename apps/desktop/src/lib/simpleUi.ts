import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { SessionRecord, SessionState } from '../types'
import { LEAD_HOME_TASK } from './chatHome'
export interface Mention {
  id: string
  token: string
  start: number
  end: number
  /** A story board item rather than a map component; saved drafts without it name components. */
  kind?: 'story'
}
export interface SimpleDiff {
  componentId: string
  path: string
  line?: number
}
export interface QueuedPrompt {
  sessionId: string
  generation: number
  text: string
  draft: string
  mentions: Mention[]
  stage: import('./simple').SimpleStage
  atMs: number
}
export interface SimpleUi {
  unconfirmed?: {
    sessionId: string
    generation: number
    text: string
    stage: import('./simple').SimpleStage
    mentions: string[]
    atMs: number
    /** The recipient's turn when the message was written (`null` for none): only a later turn's prompt can confirm it. */
    previousTurnId?: string | null
    /** Lead notes the message carried, settled once it counts as sent. */
    noteIds?: string[]
  }
  connection?: 'Connecting…' | 'Restoring context…'
  chatPreset?: string
  dismissedAssignments?: string[]
  coordinationReset?: boolean
  inputRequests?: import('./chat').ChatInputRequest[]
  pendingAction?: boolean
  pendingWorkflow?: boolean
  draft: string
  mentions: Mention[]
  diff: SimpleDiff | null
  changes: boolean
  /** The Agents tab is open in Chat or Full Navigation. */
  agents?: boolean
  queued?: QueuedPrompt
  terminal: 'closed' | 'user' | 'input'
  terminalSession?: { id: string; generation?: number; pinned?: boolean }
  /** The terminal panel fills Chat instead of the composer's place. Not persisted. */
  terminalMaximized?: boolean
  inputRequest?: string
}

/** Append a draft without losing the identity or positions of its selected scope tokens. */
export function appendDraft(
  first: Pick<SimpleUi, 'draft' | 'mentions'>,
  second: Pick<SimpleUi, 'draft' | 'mentions'>,
) {
  const separator = first.draft && second.draft ? '\n\n' : ''
  const offset = first.draft.length + separator.length
  return {
    draft: first.draft + separator + second.draft,
    mentions: [
      ...first.mentions,
      ...second.mentions.map((m) => ({ ...m, start: m.start + offset, end: m.end + offset })),
    ],
  }
}

/**
 * Typing only guesses that work resumed. Keep the question's terminal until hooks confirm it.
 * A new input wait takes the drawer even from a terminal View pinned.
 */
export function inputDrawer(
  ui: SimpleUi,
  asking: SessionRecord | undefined,
  sessions: Record<string, SessionState>,
  recordIds: readonly string[],
): SimpleUi {
  // View explicitly selects a terminal, including settled runs, until the user hides it. A pin
  // whose record is gone renders nothing, so it closes rather than holding the drawer.
  const pin = ui.terminal === 'user' && ui.terminalSession?.pinned ? ui.terminalSession : undefined
  if (pin && !recordIds.includes(pin.id))
    ui = { ...ui, terminal: 'closed', terminalSession: undefined, terminalMaximized: false }
  const pinned = pin && ui.terminalSession === pin
  if (!pinned && ui.terminal !== 'closed' && ui.terminalSession) {
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
  if (pinned) return ui
  if (ui.terminal === 'input')
    return { ...ui, terminal: 'closed', terminalSession: undefined, terminalMaximized: false }
  return ui.terminalSession ? { ...ui, terminalSession: undefined } : ui
}
export const emptySimpleUi = (): SimpleUi => ({
  draft: '',
  mentions: [],
  diff: null,
  changes: false,
  terminal: 'closed',
})
export const simpleKey = (projectId: string | undefined, task: string | null) =>
  JSON.stringify([projectId ?? '', task])
/**
 * Before one conversation per project, each worktree's Chat kept its own draft. Fold those saved
 * drafts (queued prompts are saved as drafts) into their project's conversation once, so nothing
 * typed there goes missing. A folded worktree keeps no draft, so folding again changes nothing.
 */
export function foldWorktreeDrafts(worktrees: Record<string, SimpleUi>) {
  const folded = { ...worktrees }
  for (const [key, ui] of Object.entries(worktrees)) {
    const [project, task] = JSON.parse(key) as [string, string | null]
    if (task === LEAD_HOME_TASK || !ui.draft.trim()) continue
    const home = simpleKey(project, LEAD_HOME_TASK)
    folded[home] = {
      ...emptySimpleUi(),
      ...folded[home],
      ...appendDraft(folded[home] ?? emptySimpleUi(), ui),
    }
    folded[key] = { ...ui, draft: '', mentions: [] }
  }
  return folded
}
export const useSimpleUi = create<{
  worktrees: Record<string, SimpleUi>
  patch: (key: string, patch: Partial<SimpleUi>) => void
}>()(
  persist(
    (set) => ({
      worktrees: {},
      patch: (key, patch) =>
        set((s) => ({
          worktrees: {
            ...s.worktrees,
            [key]: { ...emptySimpleUi(), ...s.worktrees[key], ...patch },
          },
        })),
    }),
    {
      name: 'patchbay.chat-drafts',
      merge: (persisted, current) => {
        const saved = (persisted as { worktrees?: Record<string, SimpleUi> } | null)?.worktrees
        return saved ? { ...current, worktrees: foldWorktreeDrafts(saved) } : current
      },
      storage: createJSONStorage(() => ({
        getItem: (key) => {
          try {
            return globalThis.window?.localStorage?.getItem(key) ?? null
          } catch {
            return null
          }
        },
        setItem: (key, value) => {
          try {
            globalThis.window?.localStorage?.setItem(key, value)
          } catch {
            /* Keep the in-memory draft if storage is full. */
          }
        },
        removeItem: (key) => {
          try {
            globalThis.window?.localStorage?.removeItem(key)
          } catch {
            /* Storage may be disabled. */
          }
        },
      })),
      partialize: (state) => ({
        worktrees: Object.fromEntries(
          Object.entries(state.worktrees).map(([key, ui]) => [
            key,
            {
              ...emptySimpleUi(),
              ...appendDraft(ui, ui.queued ?? { draft: '', mentions: [] }),
              unconfirmed: ui.unconfirmed,
              dismissedAssignments: ui.dismissedAssignments,
            },
          ]),
        ),
      }),
    },
  ),
)
/** Clear drafts and transient Chat state for removed worktrees. */
export function forgetSimpleUi(
  projectId: string,
  drop: (task: string | null) => boolean = () => true,
) {
  const { worktrees } = useSimpleUi.getState()
  const kept = Object.entries(worktrees).filter(([key]) => {
    const [project, task] = JSON.parse(key) as [string, string | null]
    return project !== projectId || !drop(task)
  })
  if (kept.length !== Object.keys(worktrees).length)
    useSimpleUi.setState({ worktrees: Object.fromEntries(kept) })
}

export const EMPTY_SIMPLE_UI = emptySimpleUi()
/** Shows a session in Chat's terminal drawer until the user hides it. */
export function pinChatTerminal(key: string, id: string, generation: number | undefined) {
  useSimpleUi.getState().patch(key, {
    terminal: 'user',
    terminalSession: { id, generation, pinned: true },
  })
}
