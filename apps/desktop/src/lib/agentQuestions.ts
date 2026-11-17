import { create } from 'zustand'
import type { AgentQuestion, UserQuestion } from '../types'
import {
  agentQuestionAnswer,
  agentQuestionClaim,
  agentQuestions,
  onAgentQuestion,
  onAgentQuestionClosed,
} from './ipc'

/**
 * Agent questions whose provider hook is waiting for a Chat answer. A question Chat doesn't
 * claim within a few seconds, skips, or leaves unanswered until its deadline goes to the
 * agent's own terminal menu instead; nothing here writes to the terminal.
 */
interface AgentQuestionsState {
  pending: Record<string, AgentQuestion>
  /** Questions this window claimed and must hand back when Chat stops showing them. */
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
    await onAgentQuestionClosed(({ id }) => remove(id))
    const waiting = await agentQuestions().catch(() => [])
    useAgentQuestions.setState((s) => ({
      pending: { ...Object.fromEntries(waiting.map((q) => [q.id, q])), ...s.pending },
    }))
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

/** Claim the questions of sessions Chat shows, so their hooks wait for an answer. */
export async function claimQuestions(sessionIds: ReadonlySet<string>) {
  const { pending, claimed } = useAgentQuestions.getState()
  for (const question of Object.values(pending)) {
    if (!sessionIds.has(question.sessionId) || claimed[question.id]) continue
    useAgentQuestions.setState((s) => ({ claimed: { ...s.claimed, [question.id]: true } }))
    const ok = await agentQuestionClaim(question.id).catch(() => false)
    if (!ok) remove(question.id)
  }
}

/** Hand claimed questions of sessions Chat no longer shows back to their terminals. */
export function releaseQuestions(sessionIds: ReadonlySet<string> | null) {
  const { pending, claimed } = useAgentQuestions.getState()
  for (const id of Object.keys(claimed)) {
    const question = pending[id]
    if (question && sessionIds?.has(question.sessionId)) continue
    remove(id)
    if (question) void agentQuestionAnswer(id, null).catch(() => {})
  }
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
