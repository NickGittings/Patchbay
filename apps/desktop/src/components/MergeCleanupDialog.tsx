import { useEffect, useState } from 'react'
import Dialog from './Dialog'
import { useStore } from '../store'
import {
  cleanupJobs,
  deleteMergedWork,
  handledCleanup,
  readyCleanup,
  type CleanupJob,
} from '../lib/mergeCleanup'

/** Mounted once in the main window, independent of the selected project or view. */
export default function MergeCleanupDialog() {
  const [job, setJob] = useState<CleanupJob>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    let disposed = false
    let checking = false
    const poll = async () => {
      if (checking || job || useStore.getState().restoring) return
      checking = true
      try {
        for (const next of cleanupJobs().filter((j) => !j.handled)) {
          if (disposed) break
          if (!(await readyCleanup(next).catch(() => false))) continue
          if (disposed) break
          if (next.choice === 'ask') {
            setError(undefined)
            setJob(next)
            break
          }
          handledCleanup(next.id)
          if (next.choice === 'delete')
            await deleteMergedWork(next).catch((e) =>
              useStore
                .getState()
                .setMessage(
                  `Merge completed. Cleanup failed: ${String(e)}`,
                  undefined,
                  undefined,
                  'warning',
                ),
            )
        }
      } finally {
        checking = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 2000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [job])
  const keep = () => {
    if (busy || !job) return
    handledCleanup(job.id)
    setJob(undefined)
  }
  if (!job) return null
  return (
    <Dialog
      title="Merge complete"
      onClose={keep}
      footer={
        <>
          <button autoFocus disabled={busy} onClick={keep}>
            Keep
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              setError(undefined)
              void deleteMergedWork(job)
                .then(() => {
                  handledCleanup(job.id)
                  setJob(undefined)
                })
                .catch((e) => setError(String(e)))
                .finally(() => setBusy(false))
            }}
          >
            {busy ? 'Deleting…' : 'Delete worktree and branch'}
          </button>
        </>
      }
    >
      <p>
        Merged <code>{job.request.sourceBranch}</code> into{' '}
        <code>{job.request.destinationBranch}</code>.
      </p>
      <p>Keep this worktree and branch, or delete them?</p>
      <p>
        <code>{job.request.source}</code>
      </p>
      <p>Deletion removes the local branch and worktree. Remote branches are kept.</p>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  )
}
