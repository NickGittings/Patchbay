import { useState } from 'react'
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
  return (
    <div className="maintenance-backdrop" onClick={() => !busy && closeMapReview()}>
      <section
        className="map-maintenance-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Review map changes"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Review map changes</h2>
        <p className="hint flush">
          Safe additions start selected. Review removals and path repairs. Apply changes the draft;
          Save persists the map.
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
                    e.target.checked
                      ? [...ids, proposal.id]
                      : ids.filter((id) => id !== proposal.id),
                  )
                }
              />
              <span>{proposal.description}</span>
            </label>
          ))}
          {!review.preview.proposals.length && <p>No structural changes found.</p>}
        </div>
        <div className="row">
          <button disabled={busy} onClick={() => void reviewRescan()}>
            Refresh preview
          </button>
          <button disabled={busy} onClick={closeMapReview}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || !selected.length}
            onClick={() => void applyMapReview(selected)}
          >
            {busy ? 'Checking…' : 'Apply selected'}
          </button>
        </div>
      </section>
    </div>
  )
}
