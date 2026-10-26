import { afterEach, beforeEach, expect, test } from 'vitest'
import type { SessionState } from '../types'
import { sessionRun, terminalStatus } from './display'
import { thread, type SimpleSnapshot } from './simple'
import { pendingInput, simpleKey, stageOpen, toggledStage, useSimpleUi } from './simpleUi'

const initialState = useSimpleUi.getInitialState()
beforeEach(() => useSimpleUi.setState(initialState, true))
afterEach(() => useSimpleUi.setState(initialState, true))

test('only the current stage opens by default', () => {
  expect(stageOpen({}, 'build', 'build')).toBe(true)
  expect(stageOpen({}, 'plan', 'build')).toBe(false)
  expect(stageOpen({ build: false }, 'build', 'build')).toBe(false)
  expect(stageOpen({ plan: true }, 'plan', 'build')).toBe(true)
})

test('toggles save both open and closed choices across stage changes', () => {
  let stages = toggledStage({}, 'review', 'plan')
  stages = toggledStage(stages, 'plan', 'plan')
  expect(stages).toEqual({ review: true, plan: false })
  expect(stageOpen(stages, 'review', 'build')).toBe(true)
  expect(stageOpen(stages, 'plan', 'build')).toBe(false)
  expect(stageOpen(stages, 'build', 'build')).toBe(true)
  expect(toggledStage(stages, 'review', 'build')).toEqual({ review: false, plan: false })
  expect(toggledStage({ plan: false }, 'plan', 'build')).toEqual({ plan: true })
})

test('reopening the current stage saves the choice even though it matches the default', () => {
  const closed = toggledStage({}, 'plan', 'plan')
  const reopened = toggledStage(closed, 'plan', 'plan')
  expect(reopened).toEqual({ plan: true })
  expect(stageOpen(reopened, 'plan', 'build')).toBe(true)
})

test('empty startup followed by recovered stage and Auto rounds never retains default openings', () => {
  const key = simpleKey('p', 't')
  useSimpleUi.getState().patch(key, { draft: 'kept' })
  const worktree = { projectId: 'p', task: 't', path: '/t' }
  const snapshot: SimpleSnapshot = { records: [], sessions: {}, simple: null, auto: null }
  expect(thread(snapshot, worktree).stage).toBe('plan')
  // The real actions arrive on restore/reconnect, then Auto continues review/fix rounds.
  const log = ['implement', 'review', 'fix', 'review', 'merge'] as const
  for (const [index, action] of log.entries()) {
    const stage = action === 'review' ? 'review' : action === 'merge' ? 'merge' : 'build'
    const model = thread(
      {
        ...snapshot,
        simple: {
          startedMs: 1,
          log: [{ id: String(index), atMs: index + 1, kind: 'action', action, stage }],
        },
      },
      worktree,
    )
    expect(model.stage).toBe(stage)
    const stages = useSimpleUi.getState().worktrees[key].stages
    expect(stages).toEqual({})
    expect(
      model.sections.filter((s) => stageOpen(stages, s.id, model.stage)).map((s) => s.id),
    ).toEqual([stage])
  }
})

test('toggles apply to the latest overrides of their worktree only', () => {
  const a = simpleKey('p', null),
    b = simpleKey('p', 't')
  const { toggleStage } = useSimpleUi.getState()
  toggleStage(a, 'review', 'plan')
  toggleStage(a, 'merge', 'plan')
  toggleStage(b, 'build', 'build')
  expect(useSimpleUi.getState().worktrees[a].stages).toEqual({ review: true, merge: true })
  expect(useSimpleUi.getState().worktrees[b].stages).toEqual({ build: false })
})

const session = (state: 'needsInput' | 'working' | 'idle', authoritative = true): SessionState => ({
  running: true,
  generation: 1,
  startedMs: 100,
  status: {
    lastOutputMs: null,
    active: false,
    agent: { state, authoritative, sinceMs: 200, message: null, prompt: null },
    url: null,
    ready: false,
    healthy: null,
    stopped: false,
    seenMs: null,
  },
})
const retained = (s: SessionState | undefined, previous?: string) =>
  pendingInput('planner', s, terminalStatus('agent', s), previous)

test('input expansion survives partial answers and quiet time until a provider confirms', () => {
  const request = retained(session('needsInput'))
  expect(request).toBe(sessionRun('planner', session('needsInput')))
  expect(retained(session('working', false), request)).toBe(request)
  expect(retained(session('idle', false), request)).toBe(request)
  expect(retained(session('working'), request)).toBeUndefined()
  expect(retained(session('idle'), request)).toBeUndefined()
  expect(retained(session('working', false))).toBeUndefined()
})

test('input expansion ends on exit, disconnect, interruption, a new run or a missing session', () => {
  const asking = session('needsInput')
  const request = retained(asking)
  for (const next of [
    { ...asking, running: false },
    { ...asking, disconnected: true },
    { ...asking, interrupted: true },
    { ...session('working', false), generation: 2 },
    { ...session('working', false), startedMs: 300 },
    undefined,
  ]) {
    expect(retained(next, request)).toBeUndefined()
  }
})

test('input disclosures are scoped and do not overwrite user stage choices', () => {
  const a = simpleKey('p', null),
    b = simpleKey('p', 't')
  const { syncInputRequests, toggleStage } = useSimpleUi.getState()
  toggleStage(a, 'plan', 'plan')
  syncInputRequests(a, { planner: 'run' })
  expect(useSimpleUi.getState().worktrees[a].stages).toEqual({ plan: false })
  expect(useSimpleUi.getState().worktrees[b]).toBeUndefined()
  const unchanged = useSimpleUi.getState()
  syncInputRequests(a, { planner: 'run' })
  expect(useSimpleUi.getState()).toBe(unchanged)
  // An explicit collapse while answering dismisses the retained input expansion.
  toggleStage(a, 'plan', 'build', ['planner'])
  expect(useSimpleUi.getState().worktrees[a].inputRequests).toEqual({})
  expect(useSimpleUi.getState().worktrees[a].stages).toEqual({ plan: false })
})
