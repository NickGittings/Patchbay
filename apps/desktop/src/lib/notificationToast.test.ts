import { expect, test } from 'vitest'
import { mergeNotificationToast, removeNotificationSession } from './notificationToast'
import type { NotificationToast } from '../types'

const batch: NotificationToast = {
  message: '3 agents need input',
  sessions: ['one', 'two', 'three'].map((sid) => ({
    sid,
    label: sid,
    message: `${sid} needs input`,
  })),
}

test('viewing one session leaves the other batch links and their messages available', () => {
  const remaining = removeNotificationSession(batch, 'two')!
  expect(remaining.sessions.map((s) => s.sid)).toEqual(['one', 'three'])
  expect(remaining.message).toBe('one needs input\nthree needs input')
  expect(removeNotificationSession(removeNotificationSession(remaining, 'one'), 'three')).toBeNull()
})

test('a later batch replaces only entries from the same session', () => {
  const merged = mergeNotificationToast(batch, {
    message: 'Agent finished',
    sessions: [{ sid: 'two', label: 'two', message: 'two finished' }],
  })!
  expect(merged.sessions).toHaveLength(3)
  expect(merged.message).toBe('one needs input\ntwo finished\nthree needs input')
})

test('native failure hints retain unread links and explicit dismissal clears all', () => {
  expect(mergeNotificationToast(batch, { message: 'Native unavailable', sessions: [] })).toBe(batch)
  expect(mergeNotificationToast(batch, null)).toBeNull()
})
