import { useState } from 'react'
import { reviewWorktreeBusy } from '../../lib/reviewAgents'
import { launchFix } from '../../lib/launchStage'
import { useStore } from '../../store'
import type { SessionRecord } from '../../types'

/** "Fix in Build →" for a review session's findings, once no reviewer still writes. */
export default function FixFindingsButton({
  record,
  hasFindings,
  primary = false,
}: {
  record: SessionRecord
  hasFindings: boolean
  /** Fixing is the worktree's next step. */
  primary?: boolean
}) {
  const [starting, setStarting] = useState(false)
  // Any review still writing to this worktree's findings, not only this one.
  const reviewing = useStore((s) =>
    reviewWorktreeBusy(s.sessionRecords, s.sessions, record.spec.cwd),
  )
  return (
    <button
      className={primary ? 'primary' : undefined}
      disabled={starting || reviewing || !hasFindings}
      title={
        reviewing
          ? 'Wait for the review to finish (or exit the reviewer); findings may still be partial'
          : 'Start a fresh agent in the reviewed worktree to address the findings'
      }
      onClick={() => {
        setStarting(true)
        // In Chat mode the agent panel shows this button too.
        void launchFix(useStore.getState().simpleMode ? 'chat' : 'manual', record, 'follow')
          .catch((e) => useStore.getState().setMessage(String(e), undefined, undefined, 'error'))
          .finally(() => setStarting(false))
      }}
    >
      {starting ? 'Starting…' : 'Fix in Build →'}
    </button>
  )
}
