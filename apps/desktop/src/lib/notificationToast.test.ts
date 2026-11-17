import { expect, test } from 'vitest'
import {
  addToastCards,
  mergeNotificationToast,
  removeToastCards,
  notificationLinkLabel,
  removeNotificationSession,
  toastPlacement,
} from './notificationToast'
import type { NotificationToast } from '../types'
import { toastNotices, type Notice } from './notificationHistory'

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

test('native failure hints show beside unread links and explicit dismissal clears all', () => {
  const hinted = mergeNotificationToast(batch, { message: 'Native unavailable', sessions: [] })!
  expect(hinted.sessions).toBe(batch.sessions)
  expect(hinted.notice).toBe('Native unavailable')
  expect(hinted.message).toBe(batch.sessions.map((s) => s.message).join('\n'))
  expect(hinted.message).toContain('one needs input')
  expect(removeNotificationSession(hinted, 'two')!.message).toBe(
    'one needs input\nthree needs input',
  )
  // Repeated hints don't pile up.
  expect(mergeNotificationToast(hinted, { message: 'Native unavailable', sessions: [] })).toEqual(
    hinted,
  )
  expect(mergeNotificationToast(batch, null)).toBeNull()
})

test('a usage notice stays above agent links that arrive after it', () => {
  const usage: NotificationToast = { message: 'Claude 5-hour limit is 96% used', sessions: [] }
  const merged = mergeNotificationToast(usage, batch)!
  expect(merged.sessions).toBe(batch.sessions)
  expect(merged.notice).toBe(usage.message)
  const later = mergeNotificationToast(merged, {
    message: 'Agent finished',
    sessions: [{ sid: 'four', label: 'four', message: 'four finished' }],
  })!
  expect(later.notice).toBe(usage.message)
  expect(later.sessions).toHaveLength(4)
  expect(mergeNotificationToast(null, batch)).toBe(batch)
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

test('usage warnings survive viewing or dropping every agent link until explicit dismissal', () => {
  const usage: NotificationToast = { message: 'Claude 5-hour limit is 96% used', sessions: [] }
  for (const combined of [
    mergeNotificationToast(usage, batch),
    mergeNotificationToast(batch, usage),
  ]) {
    const remaining = removeNotificationSession(combined, 'two')!
    expect(remaining.notice).toBe(usage.message)
    expect(remaining.sessions.map((s) => s.sid)).toEqual(['one', 'three'])
    const last = removeNotificationSession(removeNotificationSession(remaining, 'one'), 'three')
    expect(last).toEqual(usage)
    expect(mergeNotificationToast(last, null)).toBeNull()
  }
})

const card = (id: string): Notice => ({ id, kind: 'info', message: id, at: 0, read: false })

test('each link and the notice in a batch gets its own card', () => {
  const cards = addToastCards([], toastNotices({ ...batch, notice: 'Usage warning' }, 1, 0))
  expect(cards.map((c) => c.link?.sid ?? c.message)).toEqual([
    'one',
    'two',
    'three',
    'Usage warning',
  ])
})

test('cards keep the newest within the cap and replace a repeated id', () => {
  const cards = addToastCards([card('a'), card('b'), card('c')], [card('a'), card('d')], 3)
  expect(cards.map((c) => c.id)).toEqual(['c', 'a', 'd'])
})

test('removing cards for one session keeps the others', () => {
  const cards = toastNotices(batch, 1, 0)
  expect(removeToastCards(cards, (c) => c.link?.sid === 'two').map((c) => c.link?.sid)).toEqual([
    'one',
    'three',
  ])
  expect(removeToastCards(cards, () => false)).toBe(cards)
})

test('auto toast placement moves to the top in Chat and keeps explicit corners', () => {
  expect(toastPlacement('auto', true)).toBe('top-right')
  expect(toastPlacement('auto', false)).toBe('bottom-right')
  for (const chat of [true, false]) expect(toastPlacement('bottom-left', chat)).toBe('bottom-left')
})
