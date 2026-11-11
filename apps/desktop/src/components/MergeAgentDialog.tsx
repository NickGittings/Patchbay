import { useState } from 'react'
import {
  initialMergeSelection,
  reconcileMergeDestination,
  mergeDestinations,
  mergeDestinationRunning,
  reviewState,
  startMergeAgent,
} from '../lib/reviewAgents'
import { useReviewFindings } from '../lib/useReviewFindings'
import { useStore } from '../store'
import type { Worktree } from '../types'
import AgentJobDialog from './AgentJobDialog'

export default function MergeAgentDialog({
  source: active,
  worktrees,
  close,
  launched,
  onRequest,
  compact = false,
}: {
  compact?: boolean
  /** The started merge agent's request, session and when its launch began. */
  onRequest?: (request: import('../types').MergeRequest, sid: string, requestId: string) => void
  source: Worktree
  worktrees: Worktree[]
  close: () => void
  launched: (sid: string) => void
}) {
  // Capture this dialog's project so switching tabs cannot redirect a pending launch.
  const [project] = useState(() => useStore.getState().toProject())
  const [selection, setSelection] = useState(() => initialMergeSelection(active, worktrees))
  const source = worktrees.find((w) => w.path === selection.source && w.branch)
  const destination = reconcileMergeDestination(source, worktrees, selection.destination)
  // Drop invalid destinations immediately so a later source change cannot restore an old choice.
  if (destination !== selection.destination) setSelection({ ...selection, destination })
  const loaded = useReviewFindings(project.projectId, source?.branch)
  const status = reviewState(loaded?.findings, source)
  const records = useStore((s) => s.sessionRecords)
  const sessions = useStore((s) => s.sessions)
  const destinations = mergeDestinations(source, worktrees)
  const target = destinations.find((w) => w.path === destination)
  return (
    <AgentJobDialog
      role="merge"
      title={compact ? 'Merge' : 'Start merge agent'}
      compact={compact}
      source={source}
      sourceField={({ busy, clearError }) => (
        <label>
          Source worktree
          <select
            autoFocus
            aria-label="Source worktree"
            disabled={busy}
            value={source?.path ?? ''}
            onChange={(e) => {
              setSelection({ source: e.target.value, destination })
              clearError()
            }}
          >
            <option value="">Choose a source…</option>
            {worktrees
              .filter((w) => w.branch)
              .map((w) => (
                <option key={w.path} value={w.path}>
                  {w.branch} · {w.path}
                  {w.current ? ' (open worktree)' : ''}
                </option>
              ))}
          </select>
        </label>
      )}
      ready={!!source?.branch && !!target?.branch}
      running={mergeDestinationRunning(records, sessions, destination)}
      runningText="A merge agent is already running in this destination."
      offlineText="Reconnect before starting a merge agent."
      hint="Merges the whole committed branch, resolves conflicts, and runs relevant checks before completing the local merge. Both worktrees must be clean. Leaves pushing to you."
      launch={([device]) => {
        const requestId = crypto.randomUUID()
        return startMergeAgent(
          project,
          {
            source: source!.path,
            sourceBranch: source!.branch!,
            destination: target!.path,
            destinationBranch: target!.branch!,
          },
          device,
          requestId,
        ).then((sid) => {
          onRequest?.(
            {
              source: source!.path,
              sourceBranch: source!.branch!,
              destination: target!.path,
              destinationBranch: target!.branch!,
            },
            sid,
            requestId,
          )
          return sid
        })
      }}
      close={close}
      launched={launched}
    >
      {({ busy, clearError }) => (
        <>
          {(!compact || (source && (!loaded || loaded.error || status !== 'current'))) && (
            <p className="hint" aria-label="Source review status">
              {!source
                ? 'Choose a source worktree.'
                : loaded?.error
                  ? loaded.error
                  : !loaded
                    ? 'Loading review status…'
                    : status === 'none'
                      ? 'No review findings for this branch.'
                      : status === 'current'
                        ? 'Review findings are current.'
                        : 'Review findings exist; changed since review.'}
            </p>
          )}
          <label>
            Destination worktree
            <select
              aria-label="Destination worktree"
              disabled={busy}
              value={destination}
              onChange={(e) => {
                setSelection({ ...selection, destination: e.target.value })
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
