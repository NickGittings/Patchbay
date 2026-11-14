import { useEffect, useState } from 'react'
import Dialog from './Dialog'
import { projectOf, useStore } from '../store'
import { mergeCleanupPreview, type MergeCleanupPreview } from '../lib/ipc'
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
  const [preview, setPreview] = useState<MergeCleanupPreview>()
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
            setPreview(undefined)
            const project = projectOf(next.projectId)
            if (project) {
              try {
                setPreview(await mergeCleanupPreview(project, next.request))
              } catch (e) {
                setError(String(e))
              }
            }
            setJob(next)
            break
          }
          if (next.choice === 'delete') {
            try {
              await deleteMergedWork(next)
            } catch (e) {
              // Leave a persisted prompt so partial cleanup can be retried after a reload.
              useStore.setState((s) => ({
                workspaceSettings: {
                  ...s.workspaceSettings,
                  mergeCleanupJobs: cleanupJobs().map((j) =>
                    j.id === next.id ? { ...j, choice: 'ask' } : j,
                  ),
                },
              }))
              setError(String(e))
              const project = projectOf(next.projectId)
              setPreview(
                project
                  ? await mergeCleanupPreview(project, next.request).catch(() => undefined)
                  : undefined,
              )
              setJob(next)
              break
            }
          }
          handledCleanup(next.id)
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
            disabled={busy || !preview}
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
            {busy
              ? 'Cleaning up…'
              : preview?.restore
                ? `Return to ${job.request.destinationBranch} and delete feature branch`
                : 'Delete worktree and branch'}
          </button>
        </>
      }
    >
      <p>
        Merged <code>{job.request.sourceBranch}</code> into{' '}
        <code>{job.request.destinationBranch}</code>.
      </p>
      <p>
        {preview?.restore
          ? `Return the original folder to ${job.request.destinationBranch} and delete the merged feature branch?`
          : 'Keep this worktree and branch, or delete them?'}
      </p>
      <p>
        <code>{preview?.removedWorktree ?? job.request.source}</code>
      </p>
      <p>
        {preview?.restore
          ? 'Cleanup preserves the original project folder and removes the generated destination worktree. Affected terminals will stop. Remote branches are kept.'
          : 'Deletion removes the local branch and worktree. Remote branches are kept.'}
      </p>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  )
}
