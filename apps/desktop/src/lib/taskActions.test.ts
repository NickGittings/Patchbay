import { expect, test } from 'vitest'
import type { TaskActivity } from '../types'
import { taskActionState } from './taskActions'
const activity = (id: string, state: TaskActivity['state'], task = 'one'): TaskActivity => ({
  id,
  state,
  task,
  projectId: 'p',
  initiator: 'agent',
  action: { kind: 'validate', componentId: 'web' },
  report: null,
  error: state === 'failed' ? 'Action busy' : null,
  previewUrls: [],
})
test('competing failure preserves the active action and task isolation', () => {
  const activities = {
    one: activity('one', 'running'),
    two: activity('two', 'failed'),
    other: activity('other', 'running', 'other'),
  }
  expect(taskActionState(activities, 'p', 'one')).toEqual({
    graphActionBusy: true,
    graphAction: { kind: 'validateAffected', componentId: 'web' },
  })
  expect(taskActionState(activities, 'q', 'one').graphActionBusy).toBe(false)
  activities.one.state = 'finished'
  expect(taskActionState(activities, 'p', 'one')).toEqual({
    graphActionBusy: false,
    graphAction: null,
  })
  expect(taskActionState(activities, 'p', 'other').graphActionBusy).toBe(true)
})

test('environment stop activity does not replace a running validation', () => {
  const activities = {
    stop: { ...activity('stop', 'running'), action: { kind: 'environmentStop', groupId: 'dev' } },
    validate: activity('validate', 'running'),
  }
  expect(taskActionState(activities, 'p', 'one').graphAction).toEqual({
    kind: 'validateAffected',
    componentId: 'web',
  })
  activities.validate.state = 'finished'
  expect(taskActionState(activities, 'p', 'one').graphActionBusy).toBe(false)
})
