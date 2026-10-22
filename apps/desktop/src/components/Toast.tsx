import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { revealNotification } from '../lib/notifications'
import { notificationLinkLabel } from '../lib/notificationToast'
import { focusTerminal } from '../lib/terminals'

const HIDE_AFTER_MS = 6000

/**
 * The latest app message, shown in full below the toolbar. Errors and hints stay until dismissed
 * or replaced; transient confirmations hide on their own unless hovered. The live region stays
 * mounted so screen readers announce each new message.
 */
export default function Toast() {
  const message = useStore((s) => s.message)
  const id = useStore((s) => s.messageId)
  const transient = useStore((s) => s.messageTransient)
  const action = useStore((s) => s.messageAction)
  const toast = useRef<HTMLDivElement>(null)
  const notification = useStore((s) => s.notificationToast)
  const notificationId = useStore((s) => s.notificationToastId)
  const notificationElement = useRef<HTMLDivElement>(null)
  const activeProjectId = useStore((s) => s.project?.id ?? null)
  const notice = notification?.sessions.length ? notification.notice : notification?.message

  // An alert with links hides once followNotifications has dropped its last link (each one goes
  // when its session is seen or leaves that state); a notice without links hides on its own.
  useEffect(() => {
    if (!notification || notification.sessions.length) return
    let timer: ReturnType<typeof setTimeout>
    const hide = () => {
      // A background fallback must survive until the user returns to the main window.
      if (!document.hasFocus() || notificationElement.current?.matches(':hover'))
        timer = setTimeout(hide, HIDE_AFTER_MS)
      else useStore.getState().setNotificationToast(null)
    }
    const restart = () => {
      clearTimeout(timer)
      timer = setTimeout(hide, HIDE_AFTER_MS)
    }
    restart()
    window.addEventListener('focus', restart)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', restart)
    }
  }, [notification, notificationId])

  useEffect(() => {
    if (!transient) return
    // Checked when due rather than tracked, so a toast that appears under the pointer counts.
    let timer: ReturnType<typeof setTimeout>
    const hide = () => {
      if (toast.current?.matches(':hover')) timer = setTimeout(hide, 1000)
      else useStore.getState().setMessage('')
    }
    timer = setTimeout(hide, HIDE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [id, transient])

  return (
    <div className="toast-region" aria-live="polite">
      {notification && (
        <div className="toast" ref={notificationElement}>
          <div className="toast-text">
            {notice && <span className="notification-message">{notice}</span>}
            {notification.sessions.map((link) => {
              const message = notificationLinkLabel(
                { ...link, label: link.message ?? notification.message },
                activeProjectId,
              )
              return (
                <div className="notification-row" key={link.sid}>
                  <span className="notification-message" title={message}>
                    {message}
                  </span>
                  <button
                    title={message}
                    aria-label={`View ${notificationLinkLabel(link, activeProjectId)}`}
                    onClick={() => {
                      const { sid } = link
                      if (revealNotification(sid, link.auto)) {
                        if (!link.auto) focusTerminal(sid)
                        useStore.getState().dismissNotificationSession(sid)
                      }
                    }}
                  >
                    View
                  </button>
                </div>
              )
            })}
          </div>
          <button
            className="toast-close"
            aria-label="Dismiss notification"
            onClick={() => useStore.getState().setNotificationToast(null)}
          >
            ×
          </button>
        </div>
      )}
      {message && (!action?.projectId || action.projectId === activeProjectId) && (
        <div className="toast" ref={toast}>
          <span className="toast-text">{message}</span>
          {action && <button onClick={action.run}>{action.label}</button>}
          <button
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => useStore.getState().setMessage('')}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
