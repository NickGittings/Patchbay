import { create } from 'zustand'
import type { AgentQuestion, UserQuestion } from '../types'
import {
  agentQuestionAnswer,
  agentQuestionClaim,
  agentQuestions,
  agentQuestionsWatch,
  onAgentQuestion,
  onAgentQuestionClosed,
} from './ipc'

/**
 * Agent questions whose provider hook is waiting for a Chat answer. Only sessions Chat shows
 * are offered (`watchQuestions`); a question whose card doesn't claim it within a few
 * seconds, that the user skips, or that stays unanswered until its deadline goes to the
 * agent's own terminal menu instead. Nothing here writes to the terminal.
 */
interface AgentQuestionsState {
  pending: Record<string, AgentQuestion>
  /** Questions a card in this window claimed and hands back when it leaves the screen. */
  claimed: Record<string, true>
}

export const useAgentQuestions = create<AgentQuestionsState>(() => ({ pending: {}, claimed: {} }))

function remove(id: string) {
  useAgentQuestions.setState((s) => {
    const { [id]: _, ...pending } = s.pending
    const { [id]: __, ...claimed } = s.claimed
    return { pending, claimed }
  })
}

let listening: Promise<void> | undefined
/** Start following offered questions once per window. */
export function listenAgentQuestions() {
  listening ??= (async () => {
    await onAgentQuestion((question) =>
      useAgentQuestions.setState((s) => {
        // A newer question from the same session replaces the earlier one.
        const pending = Object.fromEntries(
          Object.entries(s.pending).filter(([, p]) => p.sessionId !== question.sessionId),
        )
        return { pending: { ...pending, [question.id]: question } }
      }),
    )
    // Questions that end while the list loads must not come back with it.
    let closed: Set<string> | undefined = new Set()
    await onAgentQuestionClosed(({ id }) => {
      closed?.add(id)
      remove(id)
    })
    const waiting = await agentQuestions().catch(() => [])
    const ended = closed
    closed = undefined
    useAgentQuestions.setState((s) => {
      const sessions = new Set(Object.values(s.pending).map((q) => q.sessionId))
      const listed = waiting.filter((q) => !ended.has(q.id) && !sessions.has(q.sessionId))
      return { pending: { ...Object.fromEntries(listed.map((q) => [q.id, q])), ...s.pending } }
    })
  })().catch(() => {
    listening = undefined
  })
  return listening
}

/** The pending question for a session's current process, if Chat may answer it. */
export function pendingQuestion(
  pending: Record<string, AgentQuestion>,
  sessionId: string,
  generation: number | undefined,
) {
  return Object.values(pending).find(
    (q) =>
      q.sessionId === sessionId &&
      (q.generation === null || generation === undefined || q.generation === generation),
  )
}

// Releases wait a tick, so a remount (React's development double effects, or a re-keyed
// card) keeps what it showed instead of handing it back to the terminal.
let unwatch: ReturnType<typeof setTimeout> | undefined
const releasing = new Map<string, ReturnType<typeof setTimeout>>()

/** The sessions Chat shows; `null` once it shows none. Others ask in their terminals. */
export function watchQuestions(sessionIds: readonly string[] | null) {
  clearTimeout(unwatch)
  const send = () => void agentQuestionsWatch([...(sessionIds ?? [])]).catch(() => {})
  if (sessionIds) send()
  else unwatch = setTimeout(send, 0)
}

/** A card on screen claims its question, so the hook waits for the answer. */
export async function claimQuestion(id: string) {
  clearTimeout(releasing.get(id))
  releasing.delete(id)
  if (useAgentQuestions.getState().claimed[id]) return
  useAgentQuestions.setState((s) => ({ claimed: { ...s.claimed, [id]: true } }))
  if (!(await agentQuestionClaim(id).catch(() => false))) remove(id)
}

/** A card leaving the screen hands its unanswered question back to the terminal. */
export function releaseQuestion(id: string) {
  clearTimeout(releasing.get(id))
  releasing.set(
    id,
    setTimeout(() => {
      releasing.delete(id)
      const { pending, claimed } = useAgentQuestions.getState()
      if (!claimed[id]) return
      remove(id)
      if (pending[id]) void agentQuestionAnswer(id, null).catch(() => {})
    }, 0),
  )
}

/** Send answers (or `null` for the terminal). False when the question already ended. */
export async function answerQuestion(id: string, answers: string[] | null) {
  const ok = await agentQuestionAnswer(id, answers).catch(() => false)
  remove(id)
  return ok
}

/** What the user picked for one question: option labels, and free text for "Other". */
export interface QuestionChoice {
  selected: string[]
  other: string
}

export const OTHER = '\u0000other'

/**
 * One answer per question, as the provider's own menu would give it: the chosen labels
 * (joined for multiple choice) and any "Other" text. `null` until every question is answered.
 */
export function composeAnswers(
  questions: readonly UserQuestion[],
  choices: readonly (QuestionChoice | undefined)[],
): string[] | null {
  const answers = questions.map((_, i) => {
    const choice = choices[i]
    if (!choice) return ''
    const other = choice.selected.includes(OTHER) ? choice.other.trim() : ''
    return [...choice.selected.filter((s) => s !== OTHER), other].filter(Boolean).join(', ')
  })
  return answers.every((a) => a.trim()) ? answers : null
}
