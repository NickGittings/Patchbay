import type { ReactNode } from 'react'
import type { ChangeGroup } from '../../lib/changeGroups'
import { plural } from '../../lib/display'
import { latestChange, lineTotals } from '../../lib/review'
import { PROJECT_SCOPE } from '../../types'
import DiffStat from './DiffStat'
import ValidationChips from './ValidationChips'

/** Shared component-card presentation for Review and chat Changes. */
export default function ChangeGroupCard({
  group,
  open,
  onToggle,
  onSelectComponent,
  task,
  children,
}: {
  group: ChangeGroup
  open: boolean
  onToggle: () => void
  onSelectComponent?: () => void
  task: string | null
  children: ReactNode
}) {
  const project = group.id === PROJECT_SCOPE
  return (
    <section className="review-group">
      <header className="review-group-header">
        <button
          className="review-toggle"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${group.name}`}
          onClick={onToggle}
        >
          {open ? '▾' : '▸'}
        </button>
        <span
          className={`kind-dot ${project ? 'project' : ''}`}
          style={project ? undefined : { background: group.color }}
        />
        {!project && onSelectComponent ? (
          <button className="review-name" onClick={onSelectComponent}>
            {group.name}
          </button>
        ) : (
          <span
            className="review-name"
            title={project ? 'Files no component contains' : group.name}
          >
            {group.name}
          </span>
        )}
        <span className="review-count">{plural(group.files.length, 'file')}</span>
        <DiffStat {...lineTotals(group.files)} />
      </header>
      {!project && (
        <ValidationChips componentId={group.id} changedAt={latestChange(group.files)} task={task} />
      )}
      {open && children}
    </section>
  )
}
