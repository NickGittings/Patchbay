import NoticeContent from './NoticeContent'
import { linkEventId, linkKind, type Notice } from '../lib/notificationHistory'
import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { revealNotification } from '../lib/notifications'
import { notificationLinkLabel, toastPlacement } from '../lib/notificationToast'
import { focusTerminal } from '../lib/terminals'

const HIDE_AFTER_MS = 8000

/**
 * Each incoming notice, agent link and app message gets its own card in the chosen corner. Every card
 * hides on its own after a few seconds, paused while hovered or while the window is in the
 * background; the inbox keeps the full history and the links' View buttons. The live region stays
 * mounted so screen readers announce each new card.
 */
export default function Toast() {
  const cards = useStore((s) => s.toastCards)
  const placement = useStore((s) => toastPlacement(s.notifications.toastPosition, s.simpleMode))
  const region = useRef<HTMLDivElement>(null)
  const newest = cards.at(-1)?.id
  // A stack taller than the window scrolls; keep the newest card, nearest the edge, in view.
  useEffect(() => {
    region.current?.lastElementChild?.scrollIntoView({ block: 'nearest' })
  }, [newest, placement])
  return (
    <div ref={region} className="toast-region" data-position={placement} aria-live="polite">
      {cards.map((card) => (
        <ToastCard key={card.id} card={card} />
      ))}
    </div>
  )
}

/** Hiding a card leaves an agent link live in the inbox; a notice or message goes with it. */
function hideCard(card: Notice) {
  const s = useStore.getState()
  s.dismissToastCard(card.id)
  if (card.link) return
  if (card.messageId === undefined) s.dismissNotificationNotice(card.id)
  else if (card.messageId === s.messageId) s.setMessage('')
}

function ToastCard({ card }: { card: Notice }) {
  const element = useRef<HTMLDivElement>(null)
  const activeProjectId = useStore((s) => s.project?.id ?? null)
  const messageId = useStore((s) => s.messageId)
  const action = useStore((s) => s.messageAction)

  useEffect(() => {
    // Checked when due rather than tracked, so a card that appears under the pointer counts, and
    // a card that arrives in the background survives until the user returns to the window.
    let timer: ReturnType<typeof setTimeout>
    const hide = () => {
      if (!document.hasFocus() || element.current?.matches(':hover'))
        timer = setTimeout(hide, HIDE_AFTER_MS)
      else hideCard(card)
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
  }, [card])

  const link = card.link
  if (link) {
    const label = notificationLinkLabel({ ...link, label: card.message }, activeProjectId)
    return (
      <div className="toast" ref={element}>
        <div className="toast-text notification-row">
          <NoticeContent kind={linkKind(link)}>
            <span className="notification-message" title={label}>
              {label}
            </span>
          </NoticeContent>
          <button
            title={label}
            aria-label={`View ${notificationLinkLabel(link, activeProjectId)}`}
            onClick={() => {
              // Resolve against the current live event, never a historical session ID alone.
              const current = useStore
                .getState()
                .notificationToast?.sessions.find((candidate) => linkEventId(candidate) === card.id)
              if (!current) return useStore.getState().dismissToastCard(card.id)
              if (revealNotification(current.sid, current.auto)) {
                if (!current.auto) focusTerminal(current.sid)
                useStore.getState().dismissNotificationSession(current.sid)
              }
            }}
          >
            View
          </button>
        </div>
        <button
          className="toast-close"
          aria-label="Dismiss notification"
          onClick={() => useStore.getState().dismissToastCard(card.id)}
        >
          ×
        </button>
      </div>
    )
  }

  const message = card.messageId !== undefined
  const cardAction =
    message &&
    card.messageId === messageId &&
    action &&
    (!action.projectId || action.projectId === activeProjectId)
      ? action
      : null
  return (
    <div className="toast" ref={element}>
      <NoticeContent kind={card.kind} heading={card.heading}>
        <span className="toast-text">{card.message}</span>
      </NoticeContent>
      {cardAction && <button onClick={cardAction.run}>{cardAction.label}</button>}
      <button
        className="toast-close"
        aria-label={message ? 'Dismiss' : 'Dismiss notification'}
        onClick={() => hideCard(card)}
      >
        ×
      </button>
    </div>
  )
}
