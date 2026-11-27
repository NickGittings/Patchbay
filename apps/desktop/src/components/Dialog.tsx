import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useReducedMotion } from '../lib/useReducedMotion'

/** Matches `--dur-exit`, the leave transition on `.extension-overlay[data-leaving]`. */
const LEAVE_MS = 160

export default function Dialog({
  title,
  subtitle,
  onClose,
  children,
  className = '',
  footer,
  role = 'dialog',
  dismissible = true,
  takeFocus = true,
  returnFocus,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  className?: string
  role?: 'dialog' | 'alertdialog'
  /** False while work is in flight: Escape, the backdrop, and × leave the dialog open. */
  dismissible?: boolean
  /**
   * False for a dialog that opens by itself (a review after a save): focus stays where the person
   * is typing, and Escape anywhere still closes it.
   */
  takeFocus?: boolean
  /** Where focus goes on close, when not the element focused as the dialog opened. */
  returnFocus?: Element | null
}) {
  const heading = useId()
  const card = useRef<HTMLDivElement>(null)
  // Capture before child autoFocus runs during the mount commit.
  const previous = useRef(returnFocus !== undefined ? returnFocus : document.activeElement)
  const reducedMotion = useReducedMotion()
  const [leaving, setLeaving] = useState(false)
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // The dismissed dialog's onClose, until the leave delay hands it over.
  const pendingClose = useRef<() => void>(undefined)
  useEffect(
    () => () => {
      // Unmounted mid-fade (a scope switch): the close that was asked for still happens.
      clearTimeout(leaveTimer.current)
      pendingClose.current?.()
    },
    [],
  )
  // The scrim fades out instead of vanishing, so closing never jumps the window's brightness. A
  // parent that unmounts the dialog itself (after a save) still closes at once.
  const close = () => {
    if (!dismissible || leaveTimer.current) return
    if (reducedMotion) {
      onClose()
      return
    }
    // The close that was asked for, even if the dialog shows something else by the time it lands.
    const dismissed = onClose
    pendingClose.current = dismissed
    setLeaving(true)
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = undefined
      pendingClose.current = undefined
      // A parent that keeps the dialog mounted gets it back visible and closable.
      setLeaving(false)
      dismissed()
    }, LEAVE_MS)
  }
  // `inert` dropped focus to <body>; a dialog its parent kept takes it back, so Escape and Tab work.
  const wasLeaving = useRef(false)
  useEffect(() => {
    if (wasLeaving.current && !leaving && document.activeElement === document.body)
      card.current?.focus()
    wasLeaving.current = leaving
  }, [leaving])
  const latestClose = useRef(close)
  useEffect(() => {
    latestClose.current = close
  })
  useEffect(() => {
    const back = previous.current
    if (takeFocus) {
      // A child with autoFocus (Cancel in a confirmation, a form's first field) keeps focus.
      if (!card.current?.contains(document.activeElement)) card.current?.focus()
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) latestClose.current()
    }
    if (!takeFocus) window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('keydown', escape)
      // Only reclaim focus the dialog held (it falls to <body> as the dialog unmounts), and only
      // for an element still on the page.
      const active = document.activeElement
      if ((!active || active === document.body) && back instanceof HTMLElement && back.isConnected)
        back.focus()
    }
    // Mount-only: focus and the Escape listener belong to this dialog's lifetime.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div
      className={`extension-overlay ${className}`}
      data-leaving={leaving || undefined}
      // Leaving, the dialog takes no more input: Escape then Enter can't confirm what was dismissed.
      inert={leaving}
      onClick={close}
    >
      <div
        ref={card}
        tabIndex={-1}
        className="extensions-panel panel dialog-shell"
        role={role}
        aria-modal="true"
        aria-label={title}
        aria-labelledby={heading}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.stopPropagation()
            close()
          }
          if (e.key === 'Tab') {
            const nodes = Array.from(
              e.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
              ),
            ).filter((node) => node.getClientRects().length)
            const first = nodes[0]
            const last = nodes[nodes.length - 1]
            if (
              e.shiftKey &&
              (document.activeElement === first || document.activeElement === card.current)
            ) {
              e.preventDefault()
              last?.focus()
            } else if (
              !e.shiftKey &&
              (document.activeElement === last || document.activeElement === card.current)
            ) {
              e.preventDefault()
              first?.focus()
            }
          }
        }}
      >
        <header className="utility-header">
          <div>
            <h2 id={heading}>{title}</h2>
            {subtitle && <small title={subtitle}>{subtitle}</small>}
          </div>
          <button
            aria-label={`Close ${title}`}
            title="Close"
            disabled={!dismissible}
            onClick={close}
          >
            ×
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="settings-footer">{footer}</footer>}
      </div>
    </div>
  )
}
