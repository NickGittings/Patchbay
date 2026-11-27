import { useEffect, useId, useRef, type ReactNode } from 'react'

const composing = (e: KeyboardEvent) => e.isComposing || e.keyCode === 229

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
  const close = () => {
    if (dismissible) onClose()
  }
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
      if (e.key === 'Escape' && !e.defaultPrevented && !composing(e)) latestClose.current()
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
    <div className={`extension-overlay ${className}`} onClick={close}>
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
          // Escape that cancels an IME composition belongs to the field, not the dialog.
          if (e.key === 'Escape' && !e.defaultPrevented && !composing(e.nativeEvent)) {
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
