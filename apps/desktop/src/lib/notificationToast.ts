import type { NotificationToast } from '../types'

export function mergeNotificationToast(
  current: NotificationToast | null,
  incoming: NotificationToast | null,
): NotificationToast | null {
  if (!incoming || !current?.sessions.length) return incoming
  // A test-delivery hint must also leave unread agent links available.
  if (!incoming.sessions.length) return current
  const sessions = new Map(
    current.sessions.map((entry) => [
      entry.sid,
      { ...entry, message: entry.message ?? current.message },
    ]),
  )
  for (const entry of incoming.sessions)
    sessions.set(entry.sid, { ...entry, message: entry.message ?? incoming.message })
  const entries = [...sessions.values()]
  return { message: entries.map((entry) => entry.message).join('\n'), sessions: entries }
}

export function removeNotificationSession(
  current: NotificationToast | null,
  sid: string,
): NotificationToast | null {
  if (!current) return null
  const sessions = current.sessions.filter((entry) => entry.sid !== sid)
  return sessions.length
    ? { message: sessions.map((entry) => entry.message ?? current.message).join('\n'), sessions }
    : null
}
