import { expect, test } from 'vitest'
import { DEFAULT_NOTIFICATIONS } from '../types'
import {
  mergeRestoredNotifications,
  restoredNotifications,
  sameNotifications,
} from './notificationSettings'

test('restore validates boolean fields and defaults garbage', () => {
  for (const value of [null, undefined, [], 1, true, 'bad'])
    expect(restoredNotifications(value)).toEqual(DEFAULT_NOTIFICATIONS)
  expect(
    restoredNotifications({ enabled: false, finished: 'no', needsInput: false, failed: 0 }),
  ).toEqual({ ...DEFAULT_NOTIFICATIONS, enabled: false, needsInput: false })
})

test('settings changed during restore win field by field over the saved ones', () => {
  const initial = { ...DEFAULT_NOTIFICATIONS }
  const saved = { ...DEFAULT_NOTIFICATIONS, failed: false }
  expect(mergeRestoredNotifications(saved, initial, initial)).toEqual(saved)
  // An equal copy of the initial settings changed nothing.
  expect(mergeRestoredNotifications(saved, { ...initial }, initial)).toEqual(saved)
  expect(mergeRestoredNotifications(saved, { ...initial, enabled: false }, initial)).toEqual({
    ...saved,
    enabled: false,
  })
  expect(mergeRestoredNotifications(saved, { ...initial, failed: true }, initial)).toEqual(saved)
  expect(mergeRestoredNotifications(null, { ...initial, finished: false }, initial)).toEqual({
    ...DEFAULT_NOTIFICATIONS,
    finished: false,
  })
})

test('sameNotifications compares every field', () => {
  expect(sameNotifications(DEFAULT_NOTIFICATIONS, { ...DEFAULT_NOTIFICATIONS })).toBe(true)
  for (const key of Object.keys(DEFAULT_NOTIFICATIONS) as (keyof typeof DEFAULT_NOTIFICATIONS)[])
    expect(
      sameNotifications(DEFAULT_NOTIFICATIONS, { ...DEFAULT_NOTIFICATIONS, [key]: false }),
    ).toBe(false)
})
