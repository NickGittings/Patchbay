import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import { appendNotices, linkEventId, toastNotices } from './notificationHistory'
import { mergeNotificationToast, removeNotificationSession } from './notificationToast'
import type { NotificationToast } from '../types'

const batch: NotificationToast = {
  message: 'Mixed events',
  sessions: [
    { sid: 'one', label: 'One', kind: 'needsInput', atMs: 1, message: 'Permission requested' },
    { sid: 'two', label: 'Two', kind: 'failed', atMs: 2, message: 'Agent failed' },
  ],
}
beforeEach(() => useStore.setState(useStore.getInitialState(), true))
test('mixed batches retain individual severity, message and event identity', () => {
  const entries = toastNotices(batch, 1, 50)
  expect(entries.map((entry) => entry.kind)).toEqual(['needsInput', 'error'])
  expect(entries[0].message).toBe('Permission requested')
  expect(entries[0].id).toBe(linkEventId(batch.sessions[0]))
})
test('history deduplicates delivery but retains later events from the same session', () => {
  const entries = toastNotices(batch, 1, 50)
  expect(appendNotices(entries, entries)).toHaveLength(2)
  const later = toastNotices(
    { message: 'Finished', sessions: [{ ...batch.sessions[0], kind: 'finished', atMs: 3 }] },
    2,
    60,
  )
  expect(appendNotices(entries, later).map((entry) => entry.kind)).toEqual([
    'finished',
    'needsInput',
    'error',
  ])
})
test('history retains the newest 100 events', () => {
  for (let i = 0; i < 110; i++)
    useStore.getState().setMessage(String(i), true, undefined, 'success')
  expect(useStore.getState().notificationHistory).toHaveLength(100)
  expect(useStore.getState().notificationHistory[0].message).toBe('109')
  expect(useStore.getState().notificationHistory[99].message).toBe('10')
})
test('toast dismissal and agent resolution retain history', () => {
  const state = () => useStore.getState()
  state().setMessage('Failed', false, undefined, 'error')
  state().setMessage('')
  expect(state().notificationHistory[0].kind).toBe('error')
  state().setNotificationToast(batch)
  state().dismissNotificationSession('one')
  expect(state().notificationHistory).toHaveLength(3)
  expect(state().notificationToast?.sessions).toHaveLength(1)
  state().setNotificationToast(null)
  expect(state().notificationHistory).toHaveLength(3)
})
test('message action identity survives later messages only while eligible', () => {
  const state = () => useStore.getState()
  const run = vi.fn()
  state().setMessage('Arranged', true, { label: 'Undo', run, persist: true }, 'success')
  const id = state().messageActionId
  state().setMessage('Another message')
  expect(state().messageActionId).toBe(id)
  state().messageAction?.run()
  expect(run).toHaveBeenCalledOnce()
  expect(state().messageAction).toBeNull()
  state().setMessage('')
  expect(state().messageActionId).toBeUndefined()
})
test('typed standalone notices retain presentation through merge and resolution', () => {
  const notice: NotificationToast = {
    message: 'Limit reached',
    sessions: [],
    kind: 'warning',
    heading: 'Usage limit',
  }
  const merged = mergeNotificationToast(notice, batch)!
  expect(merged.kind).toBe('warning')
  const remaining = removeNotificationSession(removeNotificationSession(merged, 'one'), 'two')!
  expect(remaining.heading).toBe('Usage limit')
  expect(remaining.message).toBe('Limit reached')
})
