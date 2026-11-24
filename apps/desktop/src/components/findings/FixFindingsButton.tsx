import { useState } from 'react'
import { reviewWorktreeBusy } from '../../lib/reviewAgents'
import WorkFeedback from '../WorkFeedback'
import { autoBlocker, workError } from '../../lib/workBlocker'
import { launchFix, taskOfWorktree } from '../../lib/launchStage'
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
  const [error, setError] = useState<{ id: string; error: Error }>()
  const blocker = () =>
    autoBlocker(
      record.metadata.projectId,
      taskOfWorktree({ path: record.spec.cwd }, record.metadata.projectId),
    )
  const blocked = useStore(() => blocker()?.message)
  const problem = (blocked && blocker()) || (error?.id === record.id ? error.error : undefined)
  // Any review still writing to this worktree's findings, not only this one.
  const reviewing = useStore((s) =>
    reviewWorktreeBusy(s.sessionRecords, s.sessions, record.spec.cwd),
  )
  return (
    <>
      <button
        className={primary ? 'primary' : undefined}
        disabled={starting || reviewing || !hasFindings || !!blocked}
        title={
          reviewing
            ? 'Wait for the review to finish (or exit the reviewer); findings may still be partial'
            : 'Start a fresh agent in the reviewed worktree to address the findings'
        }
        onClick={() => {
          setStarting(true)
          setError(undefined)
          // In Chat mode the agent panel shows this button too.
          void launchFix(useStore.getState().simpleMode ? 'chat' : 'manual', record, 'follow')
            .catch((e) => setError({ id: record.id, error: workError(e) }))
            .finally(() => setStarting(false))
        }}
      >
        {starting ? 'Starting…' : 'Fix in Build →'}
      </button>
      {problem && <WorkFeedback error={problem} />}
      {reviewing && !blocked && (
        <p role="status">Wait for the current review to finish before fixing its findings.</p>
      )}
    </>
  )
}
