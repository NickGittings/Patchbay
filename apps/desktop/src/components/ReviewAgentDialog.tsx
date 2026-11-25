import { autoBlocker } from '../lib/workBlocker'
import { useEffect, useState } from 'react'
import { launchReview, taskOfWorktree } from '../lib/launchStage'
import { gitBranches } from '../lib/ipc'
import { defaultReviewBase, reviewBases, reviewWorktreeBusy } from '../lib/reviewAgents'
import { useStore } from '../store'
import type { Worktree } from '../types'
import AgentJobDialog from './AgentJobDialog'

export default function ReviewAgentDialog({
  source,
  worktrees,
  close,
  launched,
  onError,
}: {
  source: Worktree
  worktrees: Worktree[]
  close: () => void
  launched: (sid: string) => void
  onError?: (error: Error) => void
}) {
  // Capture this dialog's project so switching tabs cannot redirect a pending launch.
  const [project] = useState(() => useStore.getState().toProject())
  const records = useStore((s) => s.sessionRecords)
  const sessions = useStore((s) => s.sessions)
  const tasks = useStore((s) => s.tasks)
  const sourceTask = taskOfWorktree(source, project.projectId)
  const blockedMessage = useStore(() => autoBlocker(project.projectId, sourceTask)?.message)
  const blocker = blockedMessage ? autoBlocker(project.projectId, sourceTask) : undefined
  const revision = useStore((s) => s.gitChanges)
  const [branches, setBranches] = useState<string[]>()
  const [branchError, setBranchError] = useState('')
  // Until the user picks one, the default follows the branches as they load.
  const [picked, setPicked] = useState<string>()
  const bases = reviewBases(source, tasks, worktrees, branches)
  const base =
    picked !== undefined && (!picked || bases.includes(picked))
      ? picked
      : defaultReviewBase(source, tasks, worktrees, branches)
  useEffect(() => {
    let disposed = false
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const list = await gitBranches(project.projectId)
        if (!disposed) {
          setBranches(list)
          setBranchError('')
        }
      } catch (e) {
        if (!disposed) setBranchError(String(e))
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    window.addEventListener('focus', refresh)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [project.projectId, revision])
  return (
    <AgentJobDialog
      role="review"
      title="Start review agent"
      source={source}
      ready={!!base && base !== source.branch}
      // A reviewer that settled is replaced, as in every flow; only one still writing blocks.
      running={reviewWorktreeBusy(records, sessions, source.path)}
      runningText="Wait for the current reviewer to finish, or exit it before starting a new review."
      blocker={blocker}
      onError={onError}
      offlineText="Reconnect before starting a review agent."
      hint="Reviews committed work since the merge base, uncommitted changes, and untracked files. Reports findings only; fixes belong in Build. Read-only behavior relies on the briefing, not on rewriting your agent command."
      launch={async (devices) => {
        const { started, errors } = await launchReview(
          'manual',
          project,
          sourceTask,
          { worktree: source.path, branch: source.branch!, base },
          devices,
        )
        if (errors.length)
          useStore
            .getState()
            .setMessage(
              `Some reviewers didn't start:\n${errors.join('\n')}`,
              undefined,
              undefined,
              'error',
            )
        return started[0].sessionId
      }}
      close={close}
      launched={launched}
    >
      {({ busy, clearError }) => (
        <>
          <label>
            Base branch
            <select
              autoFocus
              aria-label="Base branch"
              disabled={busy || !bases.length}
              value={base}
              onChange={(e) => {
                setPicked(e.target.value)
                clearError()
              }}
            >
              <option value="">
                {bases.length
                  ? 'Choose a base…'
                  : branches
                    ? 'No other branches available'
                    : 'Loading branches…'}
              </option>
              {bases.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          {branches && !bases.length && (
            <p className="hint" role="status">
              No other local branches exist in this repository. Create or fetch a base branch, then
              choose it here.
            </p>
          )}
          {branchError && <p role="alert">Could not load branches: {branchError}</p>}
          {base === source.branch && (
            <p role="status">Choose a base other than the reviewed branch.</p>
          )}
        </>
      )}
    </AgentJobDialog>
  )
}
