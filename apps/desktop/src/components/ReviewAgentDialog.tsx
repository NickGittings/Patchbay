import { useEffect, useState } from 'react'
import { gitBranches } from '../lib/ipc'
import {
  defaultReviewBase,
  reviewBases,
  reviewWorktreeRunning,
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
}: {
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
  const [branches, setBranches] = useState<string[]>([])
  // Until the user picks one, the default follows the branches as they load.
  const [picked, setPicked] = useState<string>()
  const base = picked ?? defaultReviewBase(source, tasks, worktrees, branches)
  const bases = reviewBases(source, tasks, worktrees, branches)
  useEffect(() => {
    let disposed = false
    gitBranches()
      .then((list) => {
        if (!disposed) setBranches(list)
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [])
  return (
    <AgentJobDialog
      role="review"
      title="Start review agent"
      source={source}
      ready={!!base}
      running={reviewWorktreeRunning(records, sessions, source.path)}
      runningText="A review agent is already running in this worktree."
      offlineText="Reconnect before starting a review agent."
      hint="Reviews committed work since the merge base, uncommitted changes, and untracked files. Reports findings only; fixes belong in Build. Read-only behavior relies on the briefing, not on rewriting your agent command."
      launch={async (devices) => {
        const { started, errors } = await startReviewAgents(
          project,
          { worktree: source.path, branch: source.branch!, base },
          devices,
        )
        if (errors.length)
          useStore.getState().setMessage(`Some reviewers didn't start:\n${errors.join('\n')}`)
        return started[0].sessionId
      }}
      close={close}
      launched={launched}
    >
      {({ busy, clearError }) => (
        <label>
          Base branch
          <select
            autoFocus
            aria-label="Base branch"
            disabled={busy}
            value={base}
            onChange={(e) => {
              setPicked(e.target.value)
              clearError()
            }}
          >
            <option value="">Choose a base…</option>
            {bases.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
      )}
    </AgentJobDialog>
  )
}
