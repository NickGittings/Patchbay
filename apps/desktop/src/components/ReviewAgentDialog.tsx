import { useRef, useState } from 'react'
import { defaultReviewBase, reviewWorktreeRunning, startReviewAgent } from '../lib/reviewAgents'
import { agentDevices } from '../lib/plan'
import { useStore } from '../store'
import type { Worktree } from '../types'

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
  const devices = useStore((s) => s.devices)
  const records = useStore((s) => s.sessionRecords)
  const sessions = useStore((s) => s.sessions)
  const connected = useStore((s) => s.serviceConnected)
  const agents = agentDevices(devices)
  const tasks = useStore((s) => s.tasks)
  const [base, setBase] = useState(() => defaultReviewBase(source, tasks, worktrees))
  const bases = [
    ...new Set(
      [base, ...worktrees.map((w) => w.branch), ...tasks.map((t) => t.base)].filter(
        (b): b is string => !!b,
      ),
    ),
  ]
  const [agent, setAgent] = useState(agents[0].id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const device = agents.find((d) => d.id === agent) ?? agents[0]
  const running = reviewWorktreeRunning(records, sessions, source.path)
  const submit = async () => {
    if (pending.current || !base || !source.branch || !device || !connected || running) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const sid = await startReviewAgent(
        project,
        {
          worktree: source.path,
          branch: source.branch,
          base,
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
        aria-label="Start review agent"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) close()
        }}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h2>Start review agent</h2>
        <label>
          Source branch <strong>{source.branch}</strong>
          <code>{source.path}</code>
        </label>
        <label>
          Base branch
          <select
            autoFocus
            aria-label="Base branch"
            disabled={busy}
            value={base}
            onChange={(e) => {
              setBase(e.target.value)
              setError('')
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
        <label>
          Agent
          <select
            aria-label="Agent"
            value={device.id}
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
          Reviews committed work since the merge base, uncommitted changes, and untracked files.
          Reports findings only; fixes belong in Implementation. Read-only behavior relies on the
          briefing, not on rewriting your agent command.
        </p>
        {running && <p role="status">A review agent is already running in this worktree.</p>}
        {!connected && <p role="status">Reconnect before starting a review agent.</p>}
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
            disabled={busy || !base || !device || !connected || running}
          >
            {busy ? 'Starting…' : 'Start review agent'}
          </button>
        </div>
      </form>
    </div>
  )
}
