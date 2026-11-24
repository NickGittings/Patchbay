import { useState } from 'react'
import {
  initialMergeSelection,
  reconcileMergeDestination,
  mergeDestinations,
  mergeDestinationRunning,
  reviewState,
} from '../lib/reviewAgents'
import { launchMerge, mergeAutoBlocker, taskOfWorktree } from '../lib/launchStage'
import { useMergeSourceChanges } from '../lib/useMergeSourceChanges'
import { useReviewFindings } from '../lib/useReviewFindings'
import { useStore } from '../store'
import type { Worktree } from '../types'
import AgentJobDialog from './AgentJobDialog'

export default function MergeAgentDialog({
  source: active,
  worktrees,
  branches,
  initialDestination,
  close,
  launched,
  onError,
  onRequest,
  origin,
  task,
  compact = false,
}: {
  compact?: boolean
  /** A merge agent started; it is already recorded in its worktree's chat. */
  onRequest?: () => void
  /** Which flow the dialog serves, recorded with the merge. */
  origin: 'chat' | 'manual'
  /** The opening source's task, when the caller knows it. */
  task?: string | null
  source: Worktree
  worktrees: Worktree[]
  branches: string[]
  /** The destination already chosen elsewhere, such as Chat's merge target. */
  initialDestination?: string
  close: () => void
  launched: (sid: string) => void
  onError?: (error: Error) => void
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
  const sourceTask =
    source?.path === active.path && task !== undefined
      ? task
      : source && taskOfWorktree(source, project.projectId)
  const blockedMessage = useStore(
    () => mergeAutoBlocker(project.projectId, sourceTask, target?.worktree)?.message,
  )
  const blocker = blockedMessage
    ? mergeAutoBlocker(project.projectId, sourceTask, target?.worktree)
    : undefined
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
      runningText={`A merge agent is running in ${target?.branch}. Finish the merge or stop that agent first.`}
      blocker={blocker}
      onError={onError}
      offlineText="Reconnect before starting a merge agent."
      hint="Merges the whole committed branch, resolves conflicts, and runs relevant checks before completing the local merge. The destination worktree must be clean; uncommitted source changes can be committed first. Leaves pushing to you."
      submitLabel={commitFirst ? 'Commit and merge' : undefined}
      launch={async ([device]) => {
        const requestId = crypto.randomUUID()
        try {
          const started = await launchMerge(origin, sourceTask, {
            project,
            source: source!,
            destinationBranch: target!.branch,
            device,
            requestId,
            ...(commitFirst ? { commitSource: changes } : {}),
          })
          if (started.kind !== 'started') throw new Error('The merge did not start')
          onRequest?.()
          return started.sessionId
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
          {!target && source && !destinations.length && (
            <p role="status">Create another local branch before merging this worktree.</p>
          )}
          {sourceChanges.error && (
            <p className="file-tree-error" role="alert">
              Couldn’t check for uncommitted changes: {sourceChanges.error}
            </p>
          )}
          {commitFirst && (
            <div
              className="merge-commit-changes"
              role="group"
              aria-label="Uncommitted source changes"
            >
              <p>
                {changes.length} uncommitted {changes.length === 1 ? 'change' : 'changes'} in{' '}
                <strong>{source?.branch}</strong>. Commit {changes.length === 1 ? 'it' : 'them'}{' '}
                with the merge agent before merging?
              </p>
              {/* Every entry stays reachable: confirming commits all of them. */}
              <pre tabIndex={0}>{changes.join('\n')}</pre>
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
