import { useState } from 'react'
import Dialog from './Dialog'
import { useStore } from '../store'
import { applyMapReview, closeMapReview, reviewRescan, useMaintenance } from '../lib/maintenance'

export default function MapMaintenanceReview() {
  const review = useMaintenance((s) => s.review)
  const busy = useMaintenance((s) => s.busy)
  const projectId = useStore((s) => s.project?.id)
  if (!review || review.projectId !== projectId) return null
  return <ReviewDialog key={review.preview.id} review={review} busy={busy} />
}
function ReviewDialog({
  review,
  busy,
}: {
  review: NonNullable<ReturnType<typeof useMaintenance.getState>['review']>
  busy: boolean
}) {
  const [selected, setSelected] = useState(() =>
    review.preview.proposals.filter((p) => p.selected).map((p) => p.id),
  )
  // Which button started the work in flight, so only that one says what is happening.
  const [action, setAction] = useState<'refresh' | 'apply'>()
  const run = (kind: 'refresh' | 'apply', work: () => Promise<unknown>) => {
    setAction(kind)
    void work().finally(() => setAction(undefined))
  }
  return (
    <Dialog
      title="Review map changes"
      className="centered map-maintenance-dialog"
      onClose={closeMapReview}
      dismissible={!busy}
      footer={
        <>
          <button disabled={busy} onClick={() => run('refresh', reviewRescan)}>
            {busy && action === 'refresh' ? 'Refreshing…' : 'Refresh preview'}
          </button>
          <span className="grow" />
          <button disabled={busy} onClick={closeMapReview}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || !selected.length}
            onClick={() => run('apply', () => applyMapReview(selected))}
          >
            {busy && action === 'apply' ? 'Applying…' : 'Apply selected'}
          </button>
        </>
      }
    >
      <p className="hint">
        Safe additions start selected. Review removals and path repairs. Apply changes the draft;
        Existing map configurations save automatically after Apply.
      </p>
      {review.preview.issues.map((issue) => (
        <div className="map-issue" key={issue.componentId}>
          <strong>
            {issue.componentId}: {issue.kind}
          </strong>{' '}
          — {issue.message}
        </div>
      ))}
      <div className="maintenance-proposals">
        {review.preview.proposals.map((proposal) => (
          <label className="maintenance-proposal" key={proposal.id}>
            <input
              type="checkbox"
              checked={selected.includes(proposal.id)}
              disabled={busy}
              onChange={(e) =>
                setSelected((ids) =>
                  e.target.checked ? [...ids, proposal.id] : ids.filter((id) => id !== proposal.id),
                )
              }
            />
            <span>{proposal.description}</span>
          </label>
        ))}
        {!review.preview.proposals.length && <p>No structural changes found.</p>}
      </div>
    </Dialog>
  )
}
