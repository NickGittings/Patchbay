import type { NotificationLink, NotificationToast } from '../types'

export type NoticeKind = 'error' | 'success' | 'needsInput' | 'finished' | 'warning' | 'info'
export interface Notice {
  id: string
  kind: NoticeKind
  heading?: string
  message: string
  at: number
  read: boolean
  project?: { id: string; name: string }
  link?: NotificationLink
  messageId?: number
}
export const noticeHeadings: Record<NoticeKind, string> = {
  error: 'Action failed',
  success: 'Confirmed',
  needsInput: 'Needs input',
  finished: 'Agent finished',
  warning: 'Warning',
  info: 'Information',
}
export const linkKind = (link: NotificationLink): NoticeKind =>
  link.kind === 'failed' ? 'error' : (link.kind ?? 'info')
export const linkEventId = (link: NotificationLink) =>
  JSON.stringify([link.sid, link.kind, link.atMs, link.auto?.signature])

export function appendNotices(history: Notice[], incoming: Notice[]): Notice[] {
  const ids = new Set(history.map((entry) => entry.id))
  return [...incoming.filter((entry) => !ids.has(entry.id)).reverse(), ...history].slice(0, 100)
}

export function toastNotices(toast: NotificationToast, id: number, at: number): Notice[] {
  const entries: Notice[] = toast.sessions.map((link) => ({
    id: linkEventId(link),
    kind: linkKind(link),
    message: link.message ?? toast.message,
    at,
    read: false,
    project: link.project,
    link,
  }))
  const notice = toast.sessions.length ? toast.notice : toast.message
  if (notice)
    entries.push({
      id: `notice-${id}`,
      kind: toast.kind ?? 'info',
      heading: toast.heading,
      message: notice,
      at,
      read: false,
    })
  return entries
}
