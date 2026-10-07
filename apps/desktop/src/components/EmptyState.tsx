import type { ReactNode } from 'react'

/** A centered placeholder for an area with nothing to show yet: what it is and how to fill it. */
export default function EmptyState({
  icon,
  title,
  children,
  actions,
  compact,
}: {
  icon: ReactNode
  title: string
  children?: ReactNode
  actions?: ReactNode
  compact?: boolean
}) {
  return (
    <div className={compact ? 'empty-state compact' : 'empty-state'}>
      <div className="empty-state-mark" aria-hidden>
        {icon}
      </div>
      <div className="empty-state-title">{title}</div>
      {children && <div className="empty-state-text">{children}</div>}
      {actions && <div className="empty-state-actions">{actions}</div>}
    </div>
  )
}
