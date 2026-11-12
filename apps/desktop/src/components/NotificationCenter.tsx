import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { linkEventId, noticeHeadings } from '../lib/notificationHistory'
import { revealNotification } from '../lib/notifications'
import { focusTerminal } from '../lib/terminals'
import { useRail } from '../lib/rail'
import NoticeContent from './NoticeContent'
import RailIcon from './RailIcon'
import Toast from './Toast'

export default function NotificationCenter() {
  const history = useStore((s) => s.notificationHistory)
  const toast = useStore((s) => s.notificationToast)
  const action = useStore((s) => s.messageAction)
  const actionId = useStore((s) => s.messageActionId)
  const projectId = useStore((s) => s.project?.id)
  const [open, setOpen] = useState(false)
  const announcement = useRef<HTMLSpanElement>(null)
  const latestId = useRef(history[0]?.id)
  useEffect(() => {
    const latest = history[0]
    if (latest && latest.id !== latestId.current && open && announcement.current)
      announcement.current.textContent = `${latest.heading ?? noticeHeadings[latest.kind]}. ${latest.message}`
    latestId.current = latest?.id
  }, [history, open])
  const root = useRef<HTMLDivElement>(null)
  const bell = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const unread = history.filter((entry) => !entry.read).length
  const close = () => {
    setOpen(false)
    bell.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useEffect(() => {
    if (open && history.some((entry) => !entry.read))
      useStore.setState({ notificationHistory: history.map((entry) => ({ ...entry, read: true })) })
  }, [open, history])

  return (
    <div
      className="notification-center"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          close()
        }
      }}
    >
      <button
        ref={bell}
        className="notification-bell"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        title="Notifications"
        aria-expanded={open}
        aria-controls="notification-inbox"
        onClick={() => setOpen(!open)}
      >
        <RailIcon name="bell" />
        {unread > 0 && <span className="notification-badge">{unread}</span>}
      </button>
      {open && (
        <div
          id="notification-inbox"
          className="footer-popover notification-inbox"
          ref={panel}
          tabIndex={-1}
          role="region"
          aria-label="Notifications"
        >
          <div className="footer-popover-header">
            <strong>Notifications</strong>
            <button
              disabled={!history.length}
              onClick={() => useStore.setState({ notificationHistory: [] })}
            >
              Clear history
            </button>
            <button
              className="footer-popover-icon"
              aria-label="Notification settings"
              title="Notification settings"
              onClick={() => {
                close()
                useRail.setState({ settings: 'notifications' })
              }}
            >
              <RailIcon name="settings" />
            </button>
            <button
              className="footer-popover-icon"
              aria-label="Close notifications"
              onClick={close}
            >
              ×
            </button>
          </div>
          <div className="notification-history">
            {!history.length && <p className="hint">No notifications yet.</p>}
            {history.map((entry) => {
              const link = entry.link
              const live =
                link && toast?.sessions.find((candidate) => linkEventId(candidate) === entry.id)
              const availableAction =
                entry.messageId === actionId &&
                action &&
                (!action.projectId || action.projectId === projectId)
                  ? action
                  : null
              return (
                <article className="notification-entry" key={entry.id}>
                  <NoticeContent kind={entry.kind} heading={entry.heading}>
                    <p>{entry.message}</p>
                    <div className="notification-meta">
                      {entry.project && <span>{entry.project.name}</span>}
                      <time dateTime={new Date(entry.at).toISOString()}>
                        {new Date(entry.at).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </time>
                      {live && entry.kind === 'needsInput' && <span>Pending</span>}
                    </div>
                    {link && (
                      <button
                        disabled={!live}
                        onClick={() => {
                          // Resolve against the current live event, never a historical session ID alone.
                          const current = useStore
                            .getState()
                            .notificationToast?.sessions.find(
                              (candidate) => linkEventId(candidate) === entry.id,
                            )
                          if (current && revealNotification(current.sid, current.auto)) {
                            if (!current.auto) focusTerminal(current.sid)
                            useStore.getState().dismissNotificationSession(current.sid)
                            setOpen(false)
                          }
                        }}
                      >
                        View
                      </button>
                    )}
                    {availableAction && (
                      <button
                        onClick={() => {
                          const current = useStore.getState()
                          if (
                            current.messageActionId === entry.messageId &&
                            current.messageAction &&
                            (!current.messageAction.projectId ||
                              current.messageAction.projectId === current.project?.id)
                          )
                            current.messageAction.run()
                          setOpen(false)
                        }}
                      >
                        {availableAction.label}
                      </button>
                    )}
                  </NoticeContent>
                  <button
                    className="toast-close"
                    aria-label={`Dismiss ${entry.heading ?? entry.message}`}
                    onClick={() => {
                      const state = useStore.getState()
                      if (live && link) state.dismissNotificationSession(link.sid)
                      state.dismissNotificationNotice(entry.id)
                      if (entry.messageId === state.messageId) state.setMessage('')
                      useStore.setState((s) => ({
                        notificationHistory: s.notificationHistory.filter(
                          (item) => item.id !== entry.id,
                        ),
                      }))
                    }}
                  >
                    ×
                  </button>
                </article>
              )
            })}
          </div>
        </div>
      )}
      <span className="notification-announcements" role="status" ref={announcement} />
      <div hidden={open}>
        <Toast />
      </div>
    </div>
  )
}
