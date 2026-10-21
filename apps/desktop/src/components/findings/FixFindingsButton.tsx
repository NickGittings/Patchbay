import { useState } from 'react'
import { reviewWorktreeBusy } from '../../lib/reviewAgents'
import { fixReviewFindings } from '../../lib/reviewHandoff'
import { useStore } from '../../store'
import type { SessionRecord } from '../../types'

/** "Fix in Implementation →" for a review session's findings, once no reviewer still writes. */
export default function FixFindingsButton({
  record,
  hasFindings,
}: {
  record: SessionRecord
  hasFindings: boolean
}) {
  const [starting, setStarting] = useState(false)
  // Any review still writing to this worktree's findings, not only this one.
  const reviewing = useStore((s) =>
    reviewWorktreeBusy(s.sessionRecords, s.sessions, record.spec.cwd),
  )
  return (
    <button
      disabled={starting || reviewing || !hasFindings}
      title={
        reviewing
          ? 'Wait for the review to finish (or exit the reviewer); findings may still be partial'
          : 'Start a fresh agent in the reviewed worktree to address the findings'
      }
      onClick={() => {
        setStarting(true)
        void fixReviewFindings(record)
          .catch((e) => useStore.getState().setMessage(String(e)))
          .finally(() => setStarting(false))
      }}
    >
      {starting ? 'Starting…' : 'Fix in Implementation →'}
    </button>
  )
}
