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

test('stage advances add no overrides: only the current stage opens, choices still win', () => {
  const key = simpleKey('p', 't')
  const worktree = { projectId: 'p', task: 't', path: '/t' }
  const snapshot: SimpleSnapshot = { records: [], sessions: {}, simple: null, auto: null }
  const { toggleStage } = useSimpleUi.getState()
  expect(thread(snapshot, worktree).stage).toBe('plan')
  // Closing and reopening Plan while current saves an explicit choice matching the default.
  toggleStage(key, 'plan', 'plan')
  toggleStage(key, 'plan', 'plan')
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
    expect(stages).toEqual({ plan: true })
    expect(
      model.sections.filter((s) => stageOpen(stages, s.id, model.stage)).map((s) => s.id),
    ).toEqual(['plan', stage])
  }
})

test('a stage in use stays open after an advance until the user collapses it', () => {
  const key = simpleKey('p', 't')
  // Build was open as the current stage; the thread moves to Review while it holds focus.
  expect(stageOpen({}, 'build', 'review', true)).toBe(true)
  expect(stageOpen({}, 'build', 'review', false)).toBe(false)
  expect(stageOpen({ build: false }, 'build', 'review', true)).toBe(false)
  useSimpleUi.getState().toggleStage(key, 'build', 'review', { inUse: true })
  expect(useSimpleUi.getState().worktrees[key].stages).toEqual({ build: false })
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

test('input expansion survives a partial answer until any other state', () => {
  const request = retained(session('needsInput'))
  expect(request).toBe(sessionRun('planner', session('needsInput')))
  // Typing turns the request into unconfirmed work.
  expect(retained(session('working', false), request)).toBe(request)
  // Esc or an interrupt (and quiet decay) leaves an unconfirmed idle, which nothing confirms.
  expect(retained(session('idle', false), request)).toBeUndefined()
  expect(retained(session('working'), request)).toBeUndefined()
  expect(retained(session('idle'), request)).toBeUndefined()
  expect(retained(session('working', false))).toBeUndefined()
})

test('status-file reports, never authoritative, end input expansion once they move on', () => {
  const fileReport = (state: 'needsInput' | 'working' | 'review' | 'idle') => {
    const s = session(state as 'working', false)
    return { ...s, status: { ...s.status!, agent: { ...s.status!.agent!, state, provider: null } } }
  }
  const request = retained(fileReport('needsInput'))
  expect(request).toBeDefined()
  expect(retained(fileReport('working'), request)).toBe(request)
  expect(retained(fileReport('review'), request)).toBeUndefined()
  expect(retained(fileReport('idle'), request)).toBeUndefined()
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
  syncInputRequests(a, { planner: 'run' }, [])
  expect(useSimpleUi.getState().worktrees[a].stages).toEqual({ plan: false })
  expect(useSimpleUi.getState().worktrees[b]).toBeUndefined()
  const unchanged = useSimpleUi.getState()
  syncInputRequests(a, { planner: 'run' }, [])
  expect(useSimpleUi.getState()).toBe(unchanged)
  // An explicit stage collapse while answering dismisses the retained input expansion.
  toggleStage(a, 'plan', 'build', { inputs: ['planner'] })
  expect(useSimpleUi.getState().worktrees[a].inputRequests).toEqual({})
  expect(useSimpleUi.getState().worktrees[a].stages).toEqual({ plan: false })
})

test('folding an input-expanded card keeps its stage input expansion until a new request', () => {
  const key = simpleKey('p', null)
  const ui = () => useSimpleUi.getState().worktrees[key]
  const { syncInputRequests, toggleAgent } = useSimpleUi.getState()
  syncInputRequests(key, { planner: 'run' }, [])
  toggleAgent(key, 'planner', true, true)
  expect(ui().inputRequests).toEqual({ planner: 'run' })
  expect(ui().inputCollapsed).toEqual(['planner'])
  expect(ui().expanded).toEqual([])
  // Unfolding again shows it as a manual expansion.
  toggleAgent(key, 'planner', false, true)
  expect(ui().inputCollapsed).toEqual([])
  expect(ui().expanded).toEqual(['planner'])
  toggleAgent(key, 'planner', true, true)
  expect(ui().expanded).toEqual([])
  // Asking again unfolds the card; an ended request forgets the fold.
  syncInputRequests(key, { planner: 'run' }, ['planner'])
  expect(ui().inputCollapsed).toEqual([])
  toggleAgent(key, 'planner', true, true)
  syncInputRequests(key, {}, [])
  expect(ui().inputCollapsed).toEqual([])
})
