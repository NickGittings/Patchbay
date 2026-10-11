import { useState } from 'react'
import {
  defaultMergeDestination,
  mergeDestinations,
  mergeDestinationRunning,
  reviewState,
  startMergeAgent,
} from '../lib/reviewAgents'
import type { LoadedFindings } from '../lib/useReviewFindings'
import { useStore } from '../store'
import type { Worktree } from '../types'
import AgentJobDialog from './AgentJobDialog'

export default function MergeAgentDialog({
  source,
  worktrees,
  close,
  launched,
  findings: loaded,
  latestChangeMs,
}: {
  source: Worktree
  worktrees: Worktree[]
  close: () => void
  launched: (sid: string) => void
  /** The source branch's findings, as Review already polls them. */
  findings: LoadedFindings | undefined
  latestChangeMs?: number
}) {
  // Capture this dialog's project so switching tabs cannot redirect a pending launch.
  const [project] = useState(() => useStore.getState().toProject())
  const status = reviewState(loaded?.findings, source, latestChangeMs)
  const records = useStore((s) => s.sessionRecords)
  const sessions = useStore((s) => s.sessions)
  const destinations = mergeDestinations(source, worktrees)
  const [destination, setDestination] = useState(() => defaultMergeDestination(source, worktrees))
  const target = destinations.find((w) => w.path === destination)
  return (
    <AgentJobDialog
      title="Start merge agent"
      source={source}
      ready={!!target?.branch}
      running={mergeDestinationRunning(records, sessions, destination)}
      runningText="A merge agent is already running in this destination."
      offlineText="Reconnect before starting a merge agent."
      hint="Merges the whole committed branch, resolves conflicts, and runs relevant checks before completing the local merge. Both worktrees must be clean. Leaves pushing to you."
      launch={(device) =>
        startMergeAgent(
          project,
          {
            source: source.path,
            sourceBranch: source.branch!,
            destination: target!.path,
            destinationBranch: target!.branch!,
          },
          device,
          crypto.randomUUID(),
        )
      }
      close={close}
      launched={launched}
    >
      {({ busy, clearError }) => (
        <>
          <p className="hint flush" aria-label="Source review status">
            {loaded?.error
              ? loaded.error
              : !loaded
                ? 'Loading review status…'
                : status === 'none'
                  ? 'No review findings for this branch.'
                  : status === 'current'
                    ? 'Review findings are current.'
                    : 'Review findings exist; changed since review.'}
          </p>
          <label>
            Destination worktree
            <select
              autoFocus
              aria-label="Destination worktree"
              disabled={busy}
              value={destination}
              onChange={(e) => {
                setDestination(e.target.value)
                clearError()
              }}
            >
              <option value="">Choose a destination…</option>
              {destinations.map((w) => (
                <option key={w.path} value={w.path}>
                  {w.branch} · {w.path}
                  {w.current ? ' (open worktree)' : ''}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </AgentJobDialog>
  )
}
