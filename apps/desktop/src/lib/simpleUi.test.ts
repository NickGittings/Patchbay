import { afterEach, beforeEach, expect, test } from 'vitest'
import { simpleKey, stageOpen, toggledStage, useSimpleUi } from './simpleUi'

const initialState = useSimpleUi.getInitialState()
beforeEach(() => useSimpleUi.setState(initialState, true))
afterEach(() => useSimpleUi.setState(initialState, true))

test('only the current stage opens by default', () => {
  expect(stageOpen({}, 'build', 'build')).toBe(true)
  expect(stageOpen({}, 'plan', 'build')).toBe(false)
  expect(stageOpen({ build: false }, 'build', 'build')).toBe(false)
  expect(stageOpen({ plan: true }, 'plan', 'build')).toBe(true)
})

test('choices survive stage changes until toggled back to the default', () => {
  let stages = toggledStage({}, 'review', 'plan')
  stages = toggledStage(stages, 'plan', 'plan')
  expect(stages).toEqual({ review: true, plan: false })
  // The thread moves on: the user's choices stay, and the new current stage opens.
  expect(stageOpen(stages, 'review', 'build')).toBe(true)
  expect(stageOpen(stages, 'plan', 'build')).toBe(false)
  expect(stageOpen(stages, 'build', 'build')).toBe(true)
  expect(toggledStage(stages, 'review', 'build')).toEqual({ plan: false })
  expect(toggledStage({ plan: false }, 'plan', 'build')).toEqual({ plan: true })
})

test('stages in use stay open as the thread advances, until explicitly collapsed', () => {
  expect(stageOpen({}, 'plan', 'build', true)).toBe(true)
  expect(stageOpen({}, 'plan', 'build', false)).toBe(false)
  const closed = toggledStage({}, 'plan', 'build', true)
  expect(closed).toEqual({ plan: false })
  expect(stageOpen(closed, 'plan', 'build', true)).toBe(false)
  expect(toggledStage(closed, 'plan', 'build', true)).toEqual({})
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
