import { expect, test } from 'vitest'
import { simpleKey, stageOpen, toggledStage, useSimpleUi } from './simpleUi'

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

test('toggles apply to the latest overrides of their worktree only', () => {
  const a = simpleKey('p', null),
    b = simpleKey('p', 't')
  const { toggleStage } = useSimpleUi.getState()
  toggleStage(a, 'review', 'plan')
  toggleStage(a, 'merge', 'plan')
  expect(useSimpleUi.getState().worktrees[a].stages).toEqual({ review: true, merge: true })
  expect(useSimpleUi.getState().worktrees[b]).toBeUndefined()
})
