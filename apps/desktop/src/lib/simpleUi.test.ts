import { afterEach, beforeEach, expect, test } from 'vitest'
import { simpleKey, stageOpen, stagesAfterAdvance, toggledStage, useSimpleUi } from './simpleUi'

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
  // The thread moves on: the user's choices stay, and the new current stage opens.
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

test('advancing retains the open stage but respects collapsed choices', () => {
  expect(stagesAfterAdvance({}, undefined, 'build')).toEqual({})
  expect(stagesAfterAdvance({}, 'plan', 'plan')).toEqual({})
  expect(stagesAfterAdvance({}, 'plan', 'build')).toEqual({ plan: true })
  expect(stagesAfterAdvance({ plan: false }, 'plan', 'build')).toEqual({ plan: false })
  expect(stagesAfterAdvance({ review: false }, 'plan', 'build')).toEqual({
    review: false,
    plan: true,
  })
})

test('stage transitions retain choices per worktree, including on returning to a worktree', () => {
  const a = simpleKey('p', null),
    b = simpleKey('p', 't')
  const { syncStage, toggleStage } = useSimpleUi.getState()
  syncStage(a, 'plan')
  syncStage(b, 'review')
  syncStage(a, 'build')
  expect(useSimpleUi.getState().worktrees[a].stages).toEqual({ plan: true })
  expect(useSimpleUi.getState().worktrees[b].stages).toEqual({})
  const unchanged = useSimpleUi.getState()
  syncStage(a, 'build')
  expect(useSimpleUi.getState()).toBe(unchanged)
  toggleStage(a, 'build', 'build')
  syncStage(a, 'review')
  expect(useSimpleUi.getState().worktrees[a].stages).toEqual({ plan: true, build: false })
  expect(stageOpen(useSimpleUi.getState().worktrees[a].stages, 'review', 'review')).toBe(true)
  syncStage(b, 'merge')
  expect(useSimpleUi.getState().worktrees[b].stages).toEqual({ review: true })
})

test('toggles apply to the latest overrides of their worktree only', () => {
  const a = simpleKey('p', null),
    b = simpleKey('p', 't')
  const { toggleStage } = useSimpleUi.getState()
  toggleStage(a, 'review', 'plan')
  toggleStage(a, 'merge', 'plan')
  expect(useSimpleUi.getState().worktrees[a].stages).toEqual({ review: true, merge: true })
  expect(useSimpleUi.getState().worktrees[b]).toBeUndefined()
})

test('a toggle before stage synchronization uses the retained stage shown in the chat', () => {
  const key = simpleKey('p', null)
  const { syncStage, toggleStage } = useSimpleUi.getState()
  syncStage(key, 'plan')
  // The model has advanced, but its effect has not synchronized the store yet.
  toggleStage(key, 'plan', 'build')
  syncStage(key, 'build')
  expect(useSimpleUi.getState().worktrees[key].stages).toEqual({ plan: false })
})
