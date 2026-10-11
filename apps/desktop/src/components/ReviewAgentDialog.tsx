import { useState } from 'react'
import {
  defaultReviewBase,
  reviewBases,
  reviewWorktreeRunning,
  startReviewAgent,
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
  const [base, setBase] = useState(() => defaultReviewBase(source, tasks, worktrees))
  const bases = reviewBases(source, tasks, worktrees)
  return (
    <AgentJobDialog
      title="Start review agent"
      source={source}
      ready={!!base}
      running={reviewWorktreeRunning(records, sessions, source.path)}
      runningText="A review agent is already running in this worktree."
      offlineText="Reconnect before starting a review agent."
      hint="Reviews committed work since the merge base, uncommitted changes, and untracked files. Reports findings only; fixes belong in Implementation. Read-only behavior relies on the briefing, not on rewriting your agent command."
      launch={(device) =>
        startReviewAgent(
          project,
          { worktree: source.path, branch: source.branch!, base },
          device,
          crypto.randomUUID(),
        )
      }
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
              setBase(e.target.value)
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
