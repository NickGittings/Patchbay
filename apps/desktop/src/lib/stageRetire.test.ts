import { expect, test } from 'vitest'
import { retirableStageAgents, type RetirementInput } from './stageRetire'
import type { SimpleState } from './simple'
import type { SessionState } from '../types'

const session = (state = 'review', extra: Record<string, unknown> = {}) =>
  ({
    running: true,
    generation: 1,
    status: { agent: { state, authoritative: true, sinceMs: 20, ...extra } },
  }) as unknown as SessionState
const launch = (action: string, sessionId: string, generation = 1) => ({
  id: `${action}-${sessionId}`,
  kind: 'action',
  action,
  stage: 'build',
  atMs: 10,
  sessionId,
  generation,
})
const input = (overrides: Partial<RetirementInput> = {}): RetirementInput => ({
  simple: {
    startedMs: 1,
    log: [launch('implement', 'builder'), launch('review', 'reviewer'), launch('fix', 'fixer')],
  } as unknown as SimpleState,
  sessions: { builder: session(), reviewer: session(), fixer: session() },
  launched: ['next'],
  foreign: new Set(),
  ...overrides,
})

test('the next stage retires every earlier agent whose turn finished', () => {
  expect(retirableStageAgents(input())).toEqual(['builder', 'reviewer', 'fixer'])
})

test('agents that may still be needed keep running', () => {
  const only = (sessions: Record<string, SessionState>, extra: Partial<RetirementInput> = {}) =>
    retirableStageAgents(input({ sessions, ...extra }))
  for (const state of ['working', 'needsInput', 'idle', 'ended'])
    expect(only({ builder: session(state) })).toEqual([])
  expect(only({ builder: session('review', { approvalPending: true }) })).toEqual([])
  expect(only({ builder: session('review', { authoritative: false }) })).toEqual([])
  expect(only({ builder: { ...session(), running: false } })).toEqual([])
  expect(only({ builder: { ...session(), disconnected: true } as SessionState })).toEqual([])
  expect(only({ builder: { ...session(), generation: 2 } })).toEqual([])
  const builder = { builder: session() }
  expect(only(builder, { launched: ['builder'] })).toEqual([])
  expect(only(builder, { foreign: new Set(['builder']) })).toEqual([])
  expect(only(builder, { leadSession: 'builder' })).toEqual([])
  expect(only(builder, { queuedSession: 'builder' })).toEqual([])
})

test('an agent prompted since its last finished turn keeps running', () => {
  const simple = {
    startedMs: 1,
    log: [
      launch('implement', 'builder'),
      { id: 'next', kind: 'prompt', atMs: 30, sessionId: 'builder', generation: 1, text: 'More' },
    ],
  } as unknown as SimpleState
  expect(retirableStageAgents(input({ simple, sessions: { builder: session() } }))).toEqual([])
})

test('only stage agents this chat launched are retired', () => {
  const simple = {
    startedMs: 1,
    log: [launch('plan', 'planner'), launch('merge', 'merger')],
  } as unknown as SimpleState
  const sessions = { planner: session(), merger: session(), other: session() }
  expect(retirableStageAgents(input({ simple, sessions }))).toEqual([])
})

test.each(['running', 'waitingOnYou', 'paused'])('Auto %s keeps its agents', (autoStatus) => {
  expect(retirableStageAgents(input({ autoStatus }))).toEqual([])
})

test('a finished Auto run no longer owns the chat agents', () => {
  expect(retirableStageAgents(input({ autoStatus: 'done' }))).toHaveLength(3)
})

test('agents Auto launched stay its own after its run ends', () => {
  const simple = {
    startedMs: 1,
    log: [
      { ...launch('fix', 'autoFixer'), origin: 'auto' },
      { ...launch('implement', 'builder'), origin: 'manual' },
    ],
  } as unknown as SimpleState
  const sessions = { autoFixer: session(), builder: session() }
  expect(retirableStageAgents(input({ simple, sessions, autoStatus: 'failed' }))).toEqual([
    'builder',
  ])
})
