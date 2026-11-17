import { beforeEach, expect, test, vi } from 'vitest'
import type { AgentQuestion, UserQuestion } from '../types'

const calls: { claim: string[]; answer: [string, string[] | null][]; watch: string[][] } = {
  claim: [],
  answer: [],
  watch: [],
}
vi.mock('./ipc', () => ({
  agentQuestions: async () => [],
  agentQuestionClaim: async (id: string) => {
    calls.claim.push(id)
    return id !== 'gone'
  },
  agentQuestionAnswer: async (id: string, answers: string[] | null) => {
    calls.answer.push([id, answers])
    return true
  },
  agentQuestionsWatch: async (ids: string[]) => {
    calls.watch.push(ids)
  },
  onAgentQuestion: async () => () => {},
  onAgentQuestionClosed: async () => () => {},
}))

const {
  claimQuestion,
  composeAnswers,
  OTHER,
  pendingQuestion,
  releaseQuestion,
  watchQuestions,
  useAgentQuestions,
} = await import('./agentQuestions')

const question = (q: string, options: string[], multiSelect = false): UserQuestion => ({
  question: q,
  multiSelect,
  options: options.map((label) => ({ label })),
})
const offered = (id: string, sessionId: string, generation: number | null = 1): AgentQuestion => ({
  id,
  projectId: 'p',
  task: null,
  sessionId,
  generation,
  questions: [question('Pick', ['A'])],
  deadlineMs: 0,
})

beforeEach(() => {
  calls.claim = []
  calls.answer = []
  calls.watch = []
  useAgentQuestions.setState({ pending: {}, claimed: {} })
})

test('answers need every question answered, joining multiple choices and Other text', () => {
  const questions = [question('Color', ['Red', 'Blue']), question('Sizes', ['S', 'M'], true)]
  expect(composeAnswers(questions, [{ selected: ['Red'], other: '' }])).toBeNull()
  expect(
    composeAnswers(questions, [
      { selected: ['Blue'], other: 'ignored' },
      { selected: ['S', OTHER], other: ' XL ' },
    ]),
  ).toEqual(['Blue', 'S, XL'])
  expect(composeAnswers(questions, [{ selected: [OTHER], other: '  ' }, undefined])).toBeNull()
  expect(composeAnswers([question('Name?', [])], [{ selected: [OTHER], other: 'Ada' }])).toEqual([
    'Ada',
  ])
})

test('a pending question belongs to its session’s current process only', () => {
  const pending = { a: offered('a', 's', 2) }
  expect(pendingQuestion(pending, 's', 2)?.id).toBe('a')
  expect(pendingQuestion(pending, 's', 3)).toBeUndefined()
  expect(pendingQuestion(pending, 'other', 2)).toBeUndefined()
})

test('a card claims its question, and leaving the screen hands it back', async () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  useAgentQuestions.setState({ pending: { a: offered('a', 'lead'), gone: offered('gone', 'x') } })
  await claimQuestion('gone')
  expect(useAgentQuestions.getState().pending.gone).toBeUndefined()
  await claimQuestion('a')
  await claimQuestion('a')
  expect(calls.claim).toEqual(['gone', 'a'])

  // A remount (development double effects) keeps the claim.
  releaseQuestion('a')
  await claimQuestion('a')
  await tick()
  expect(calls.answer).toEqual([])

  releaseQuestion('a')
  await tick()
  expect(calls.answer).toEqual([['a', null]])
  expect(useAgentQuestions.getState().pending.a).toBeUndefined()
})

test('Chat tells the desktop which sessions it shows, keeping them across a remount', async () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  watchQuestions(['lead'])
  watchQuestions(null)
  watchQuestions(['lead'])
  await tick()
  expect(calls.watch).toEqual([['lead'], ['lead']])
  watchQuestions(null)
  await tick()
  expect(calls.watch).toEqual([['lead'], ['lead'], []])
})
