import type { ReactNode } from 'react'

/** Shared hierarchy for utility panels; disclosures keep configuration close to its context. */
export default function PanelSection({
  title,
  actions,
  children,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rail-section" aria-label={title}>
      <div className="rail-section-header">
        <h3>{title}</h3>
        {actions && <div className="panel-actions">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

export function PanelDetails({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rail-details">
      <summary>{title}</summary>
      <div className="rail-details-body">{children}</div>
    </details>
  )
}
