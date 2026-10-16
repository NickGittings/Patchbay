import { expect, test } from 'vitest'
import {
  mergeNotificationToast,
  notificationLinkLabel,
  removeNotificationSession,
} from './notificationToast'
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

test('removing an unknown session keeps the same toast', () => {
  expect(removeNotificationSession(batch, 'missing')).toBe(batch)
  expect(removeNotificationSession(null, 'one')).toBeNull()
})

test('links name their project only while another project is active', () => {
  const link = {
    sid: 'one',
    label: 'Review agent · Codex · feature',
    project: { id: 'p', name: 'Api' },
  }
  expect(notificationLinkLabel(link, 'p')).toBe('Review agent · Codex · feature')
  expect(notificationLinkLabel(link, 'q')).toBe('Review agent · Codex · feature · Api')
  expect(notificationLinkLabel({ sid: 'one', label: 'Root' }, null)).toBe('Root')
})
