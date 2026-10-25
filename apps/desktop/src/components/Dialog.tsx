import { useEffect, useId, useRef, type ReactNode } from 'react'

export default function Dialog({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
}) {
  const heading = useId()
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    card.current?.focus()
    return () => previous?.focus()
  }, [])
  return (
    <div className="extension-overlay" onClick={onClose}>
      <div
        ref={card}
        tabIndex={-1}
        className="extensions-panel panel dialog-shell"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-labelledby={heading}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.stopPropagation()
            onClose()
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
          <button aria-label={`Close ${title}`} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  )
}
