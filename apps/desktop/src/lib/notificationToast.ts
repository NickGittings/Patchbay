import type { NotificationLink, NotificationToast } from '../types'

export function mergeNotificationToast(
  current: NotificationToast | null,
  incoming: NotificationToast | null,
): NotificationToast | null {
  if (!incoming) return null
  if (!current?.sessions.length) {
    // A notice without links (a usage warning, a native hint) stays above the links that follow.
    if (!current || !incoming.sessions.length || incoming.notice) return incoming
    return {
      ...incoming,
      kind: current.kind,
      heading: current.heading,
      notice: current.notice ?? current.message,
      ...(current.noticeId ? { noticeId: current.noticeId } : {}),
    }
  }
  // A notice without links stays above the unread agent links until explicitly dismissed.
  if (!incoming.sessions.length) {
    const links = current.sessions.every((entry) => entry.message !== undefined)
      ? current.sessions.map((entry) => entry.message).join('\n')
      : current.message
    return {
      ...(incoming.kind ? { kind: incoming.kind } : {}),
      ...(incoming.heading ? { heading: incoming.heading } : {}),
      notice: incoming.notice ?? incoming.message,
      ...(incoming.noticeId ? { noticeId: incoming.noticeId } : {}),
      message: links,
      sessions: current.sessions,
    }
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
  const notice = incoming.notice ?? current.notice
  const noticeId = incoming.notice ? incoming.noticeId : current.noticeId
  return {
    ...(notice ? { notice } : {}),
    ...(noticeId ? { noticeId } : {}),
    ...((incoming.kind ?? current.kind) ? { kind: incoming.kind ?? current.kind } : {}),
    ...((incoming.heading ?? current.heading)
      ? { heading: incoming.heading ?? current.heading }
      : {}),
    message: entries.map((entry) => entry.message).join('\n'),
    sessions: entries,
  }
}

export function removeNotificationSession(
  current: NotificationToast | null,
  sid: string,
): NotificationToast | null {
  if (!current?.sessions.some((entry) => entry.sid === sid)) return current
  const sessions = current.sessions.filter((entry) => entry.sid !== sid)
  return sessions.length
    ? {
        ...current,
        message: sessions.map((entry) => entry.message ?? current.message).join('\n'),
        sessions,
      }
    : current.notice
      ? {
          message: current.notice,
          sessions: [],
          ...(current.noticeId ? { noticeId: current.noticeId } : {}),
          ...(current.kind ? { kind: current.kind } : {}),
          ...(current.heading ? { heading: current.heading } : {}),
        }
      : null
}

export function removeNotificationNotice(
  current: NotificationToast | null,
  id: string,
): NotificationToast | null {
  if (current?.noticeId !== id) return current
  return current.sessions.length ? { message: current.message, sessions: current.sessions } : null
}

/** The link's label or message: name the project only when it isn't the active one. */
export function notificationLinkLabel(link: NotificationLink, activeProjectId: string | null) {
  return link.project && link.project.id !== activeProjectId
    ? `${link.label} · ${link.project.name}`
    : link.label
}
