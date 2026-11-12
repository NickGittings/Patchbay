import { useEffect, useState } from 'react'
import { startSimpleReview, type StartedReviewer } from '../lib/simpleReview'
import { gitBranches } from '../lib/ipc'
import {
  defaultReviewBase,
  reviewBases,
  reviewWorktreeRunning,
  reviewWorktreeBusy,
  startReviewAgents,
} from '../lib/reviewAgents'
import { useStore } from '../store'
import type { Worktree } from '../types'
import AgentJobDialog from './AgentJobDialog'

export default function ReviewAgentDialog({
  source,
  worktrees,
  close,
  launched,
  started: onStarted,
  restartSettled = false,
  initialBase,
  compact = false,
}: {
  compact?: boolean
  initialBase?: string
  restartSettled?: boolean
  /** Every reviewer started, each with its launch request. */
  started?: (reviewers: StartedReviewer[]) => void
  source: Worktree
  worktrees: Worktree[]
  close: () => void
  launched: (sid: string) => void
}) {
  // Capture this dialog's project so switching tabs cannot redirect a pending launch.
  const [project] = useState(() => useStore.getState().toProject())
  const records = useStore((s) => s.sessionRecords)
  const sessions = useStore((s) => s.sessions)
  const tasks = useStore((s) => s.tasks)
  const revision = useStore((s) => s.gitChanges)
  const [branches, setBranches] = useState<string[]>()
  const [branchError, setBranchError] = useState('')
  // Until the user picks one, the default follows the branches as they load.
  const [picked, setPicked] = useState(initialBase)
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
      title={compact ? 'Review' : 'Start review agent'}
      compact={compact}
      source={source}
      ready={!!base && base !== source.branch}
      running={(restartSettled ? reviewWorktreeBusy : reviewWorktreeRunning)(
        records,
        sessions,
        source.path,
      )}
      runningText="A review agent is already running in this worktree."
      offlineText="Reconnect before starting a review agent."
      hint="Reviews committed work since the merge base, uncommitted changes, and untracked files. Reports findings only; fixes belong in Build. Read-only behavior relies on the briefing, not on rewriting your agent command."
      launch={async (devices) => {
        const { started, errors } = await (restartSettled ? startSimpleReview : startReviewAgents)(
          project,
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
        onStarted?.(started)
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
