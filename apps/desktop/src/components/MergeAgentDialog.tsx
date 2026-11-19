import { useState } from 'react'
import {
  initialMergeSelection,
  reconcileMergeDestination,
  mergeDestinations,
  mergeDestinationRunning,
  reviewState,
  startBranchMerge,
} from '../lib/reviewAgents'
import { useMergeSourceChanges } from '../lib/useMergeSourceChanges'
import { useReviewFindings } from '../lib/useReviewFindings'
import { useStore } from '../store'
import type { Worktree } from '../types'
import AgentJobDialog from './AgentJobDialog'

const SHOWN_CHANGES = 8

export default function MergeAgentDialog({
  source: active,
  worktrees,
  branches,
  initialDestination,
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
  branches: string[]
  /** The destination already chosen elsewhere, such as Chat's merge target. */
  initialDestination?: string
  close: () => void
  launched: (sid: string) => void
}) {
  // Capture this dialog's project so switching tabs cannot redirect a pending launch.
  const [project] = useState(() => useStore.getState().toProject())
  const [selection, setSelection] = useState(() => {
    const initial = initialMergeSelection(active, worktrees, branches)
    return { ...initial, destination: initialDestination || initial.destination }
  })
  const source = worktrees.find((w) => w.path === selection.source && w.branch)
  const destination = reconcileMergeDestination(source, worktrees, selection.destination, branches)
  // Drop invalid destinations immediately so a later source change cannot restore an old choice.
  if (destination !== selection.destination) setSelection({ ...selection, destination })
  const loaded = useReviewFindings(project.projectId, source?.branch)
  const status = reviewState(loaded?.findings, source)
  const records = useStore((s) => s.sessionRecords)
  const sessions = useStore((s) => s.sessions)
  const destinations = mergeDestinations(source, worktrees, branches)
  const target = destinations.find((d) => d.branch === destination)
  const sourceChanges = useMergeSourceChanges(project, source?.path, source?.branch)
  const changes = sourceChanges.changes
  const commitFirst = !!changes?.length
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
      ready={!!source?.branch && !!target?.branch && !!changes}
      running={mergeDestinationRunning(records, sessions, target?.worktree?.path ?? '')}
      runningText="A merge agent is already running in this destination."
      offlineText="Reconnect before starting a merge agent."
      hint="Merges the whole committed branch, resolves conflicts, and runs relevant checks before completing the local merge. The destination worktree must be clean; uncommitted source changes can be committed first. Leaves pushing to you."
      submitLabel={commitFirst ? 'Commit and merge' : undefined}
      launch={async ([device]) => {
        const requestId = crypto.randomUUID()
        try {
          const { request, sid } = await startBranchMerge(
            project,
            source!,
            target!.branch,
            device,
            requestId,
            ...(commitFirst ? [changes] : []),
          )
          onRequest?.(request, sid, requestId)
          return sid
        } catch (e) {
          // The confirmed list may be what went stale; show the current one for the retry.
          sourceChanges.reload()
          throw e
        }
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
          {sourceChanges.error && (
            <p className="file-tree-error" role="alert">
              Couldn’t check for uncommitted changes: {sourceChanges.error}
            </p>
          )}
          {commitFirst && (
            <div className="merge-commit-changes" aria-label="Uncommitted source changes">
              <p>
                {changes.length} uncommitted {changes.length === 1 ? 'change' : 'changes'} in{' '}
                <strong>{source?.branch}</strong>. Commit {changes.length === 1 ? 'it' : 'them'}{' '}
                with the merge agent before merging?
              </p>
              <pre>
                {changes.slice(0, SHOWN_CHANGES).join('\n')}
                {changes.length > SHOWN_CHANGES
                  ? `\n…and ${changes.length - SHOWN_CHANGES} more`
                  : ''}
              </pre>
            </div>
          )}
          <label>
            Destination branch
            <select
              aria-label="Destination branch"
              disabled={busy}
              value={destination}
              onChange={(e) => {
                setSelection({ ...selection, destination: e.target.value })
                clearError()
              }}
            >
              <option value="">Choose a destination…</option>
              {destinations.map(({ branch, worktree }) => (
                <option key={branch} value={branch}>
                  {branch} · {worktree ? worktree.path : 'Create worktree'}
                  {worktree?.current ? ' (open worktree)' : ''}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </AgentJobDialog>
  )
}
