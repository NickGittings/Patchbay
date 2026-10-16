import type { NotificationLink, NotificationToast } from '../types'

export function mergeNotificationToast(
  current: NotificationToast | null,
  incoming: NotificationToast | null,
): NotificationToast | null {
  if (!incoming || !current?.sessions.length) return incoming
  // A hint without links shows above the unread agent links, which stay available; it goes once
  // they are viewed, since each link's own message rebuilds the text.
  if (!incoming.sessions.length) {
    const links = current.sessions.every((entry) => entry.message !== undefined)
      ? current.sessions.map((entry) => entry.message).join('\n')
      : current.message
    return { message: `${incoming.message}\n${links}`, sessions: current.sessions }
  }
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
  if (!current?.sessions.some((entry) => entry.sid === sid)) return current
  const sessions = current.sessions.filter((entry) => entry.sid !== sid)
  return sessions.length
    ? { message: sessions.map((entry) => entry.message ?? current.message).join('\n'), sessions }
    : null
}

/** The button text: the project is named only when it isn't the active one. */
export function notificationLinkLabel(link: NotificationLink, activeProjectId: string | null) {
  return link.project && link.project.id !== activeProjectId
    ? `${link.label} · ${link.project.name}`
    : link.label
}
