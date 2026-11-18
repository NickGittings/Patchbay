import { useEffect, useId, useRef, type ReactNode } from 'react'

export default function Dialog({
  title,
  subtitle,
  onClose,
  children,
  className = '',
  footer,
  role = 'dialog',
  dismissible = true,
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
}) {
  const heading = useId()
  const card = useRef<HTMLDivElement>(null)
  // Capture before child autoFocus runs during the mount commit.
  const previous = useRef(document.activeElement as HTMLElement | null)
  const close = () => {
    if (dismissible) onClose()
  }
  useEffect(() => {
    card.current?.focus()
    return () => previous.current?.focus()
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
