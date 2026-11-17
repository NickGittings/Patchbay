import { shortSha } from '../../lib/commitId'
import { useStore } from '../../store'
import type { AutoRun } from '../../types'

/** The merge choices, or for a run in place, which commit it reviews against instead. */
export default function MergeFields({
  inPlaceBase,
  mode,
  onMode,
  cleanup,
  destination,
  destinations,
  onDestination,
}: {
  inPlaceBase: { branch: string; head: string } | null
  mode: AutoRun['merge']['mode']
  onMode: (mode: AutoRun['merge']['mode']) => void
  cleanup: string
  destination: string
  destinations: string[]
  onDestination: (destination: string) => void
}) {
  if (inPlaceBase)
    return (
      <p className="auto-hint">
        Runs in place on {inPlaceBase.branch}, reviewing against {shortSha(inPlaceBase.head)}, no
        merge.
      </p>
    )
  return (
    <>
      <label className="auto-toggle">
        <input
          type="checkbox"
          checked={mode === 'auto'}
          onChange={(e) => onMode(e.target.checked ? 'auto' : 'ask')}
        />
        Merge automatically after review
      </label>
      <label>
        After merge
        <select
          value={cleanup}
          onChange={(e) =>
            useStore.setState((s) => ({
              workspaceSettings: { ...s.workspaceSettings, mergeCleanup: e.target.value },
            }))
          }
        >
          <option value="ask">Ask</option>
          <option value="keep">Keep worktree and branch</option>
          <option value="delete">Delete worktree and branch</option>
        </select>
        <small className="auto-hint">Remembered for new Auto runs in all projects.</small>
      </label>
      <label>
        Destination branch
        <select value={destination} onChange={(e) => onDestination(e.target.value)}>
          <option value="">Choose a destination worktree</option>
          {destinations.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </label>
    </>
  )
}
