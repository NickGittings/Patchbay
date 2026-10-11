import { useRef, useState } from 'react'
import {
  defaultMergeDestination,
  mergeDestinations,
  mergeDestinationRunning,
  startMergeAgent,
} from '../lib/merge'
import { agentDevices } from '../lib/plan'
import { useStore } from '../store'
import type { Worktree } from '../types'

export default function MergeAgentDialog({
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
  const devices = useStore((s) => s.devices)
  const records = useStore((s) => s.sessionRecords)
  const sessions = useStore((s) => s.sessions)
  const connected = useStore((s) => s.serviceConnected)
  const agents = agentDevices(devices)
  const destinations = mergeDestinations(source, worktrees)
  const [destination, setDestination] = useState(() => defaultMergeDestination(source, worktrees))
  const [agent, setAgent] = useState(agents[0].id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const target = destinations.find((w) => w.path === destination)
  const device = agents.find((d) => d.id === agent)
  const running = mergeDestinationRunning(records, sessions, destination)
  const submit = async () => {
    if (pending.current || !target?.branch || !source.branch || !device || !connected || running)
      return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const sid = await startMergeAgent(
        project,
        {
          source: source.path,
          sourceBranch: source.branch,
          destination: target.path,
          destinationBranch: target.branch,
        },
        device,
        crypto.randomUUID(),
      )
      launched(sid)
    } catch (e) {
      setError(String(e))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <div
      className="extension-overlay centered"
      onClick={() => {
        if (!busy) close()
      }}
    >
      <form
        className="extensions-panel task-dialog merge-agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Start merge agent"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) close()
        }}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h2>Start merge agent</h2>
        <label>
          Source branch <strong>{source.branch}</strong>
          <code>{source.path}</code>
        </label>
        <label>
          Destination worktree
          <select
            autoFocus
            aria-label="Destination worktree"
            disabled={busy}
            value={destination}
            onChange={(e) => {
              setDestination(e.target.value)
              setError('')
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
        <label>
          Agent
          <select
            aria-label="Agent"
            value={agent}
            disabled={busy}
            onChange={(e) => setAgent(e.target.value)}
          >
            {agents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <p className="hint flush">
          Merges the whole committed branch, resolves conflicts, and runs relevant checks before
          completing the local merge. Both worktrees must be clean. Leaves pushing to you.
        </p>
        {running && <p role="status">A merge agent is already running in this destination.</p>}
        {!connected && <p role="status">Reconnect before starting a merge agent.</p>}
        {error && (
          <p className="file-tree-error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <span className="spacer" />
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !target || !device || !connected || running}
          >
            {busy ? 'Starting…' : 'Start merge agent'}
          </button>
        </div>
      </form>
    </div>
  )
}
