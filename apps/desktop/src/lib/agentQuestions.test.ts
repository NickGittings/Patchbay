import { beforeEach, expect, test, vi } from 'vitest'
import type { AgentQuestion, UserQuestion } from '../types'

const calls: { claim: string[]; answer: [string, string[] | null][] } = { claim: [], answer: [] }
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
  onAgentQuestion: async () => () => {},
  onAgentQuestionClosed: async () => () => {},
}))

const {
  claimQuestions,
  composeAnswers,
  OTHER,
  pendingQuestion,
  releaseQuestions,
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
  claimed: false,
})

beforeEach(() => {
  calls.claim = []
  calls.answer = []
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

test('Chat claims only the questions of agents it shows, and hands them back when it stops', async () => {
  useAgentQuestions.setState({
    pending: { a: offered('a', 'lead'), b: offered('b', 'worker'), gone: offered('gone', 'lead2') },
  })
  await claimQuestions(new Set(['lead', 'lead2']))
  expect(calls.claim).toEqual(['a', 'gone'])
  expect(Object.keys(useAgentQuestions.getState().pending).sort()).toEqual(['a', 'b'])
  await claimQuestions(new Set(['lead']))
  expect(calls.claim).toEqual(['a', 'gone'])

  releaseQuestions(new Set(['lead']))
  expect(calls.answer).toEqual([])
  releaseQuestions(null)
  expect(calls.answer).toEqual([['a', null]])
  expect(useAgentQuestions.getState().pending.a).toBeUndefined()
})
