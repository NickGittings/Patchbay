import { useRef, useState, type ReactNode } from 'react'
import { agentDevices } from '../lib/plan'
import { useStore } from '../store'
import type { DeviceManifest, Worktree } from '../types'

/** The shared shell of the review and merge dialogs: agent picker, launch guard and errors. */
export default function AgentJobDialog({
  title,
  source,
  ready,
  running,
  runningText,
  offlineText,
  hint,
  launch,
  close,
  launched,
  children,
}: {
  title: string
  source: Worktree
  /** The job-specific fields are complete. */
  ready: boolean
  running: boolean
  runningText: string
  offlineText: string
  hint: ReactNode
  launch: (device: DeviceManifest) => Promise<string>
  close: () => void
  launched: (sid: string) => void
  children: (props: { busy: boolean; clearError: () => void }) => ReactNode
}) {
  const devices = useStore((s) => s.devices)
  const connected = useStore((s) => s.serviceConnected)
  const agents = agentDevices(devices)
  const [agent, setAgent] = useState(agents[0].id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const device = agents.find((d) => d.id === agent) ?? agents[0]
  const submit = async () => {
    if (pending.current || !ready || !source.branch || !device || !connected || running) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      launched(await launch(device))
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
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) close()
        }}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h2>{title}</h2>
        <label>
          Source branch <strong>{source.branch}</strong>
          <code>{source.path}</code>
        </label>
        {children({ busy, clearError: () => setError('') })}
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
        <p className="hint flush">{hint}</p>
        {running && <p role="status">{runningText}</p>}
        {!connected && <p role="status">{offlineText}</p>}
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
            disabled={busy || !ready || !device || !connected || running}
          >
            {busy ? 'Starting…' : title}
          </button>
        </div>
      </form>
    </div>
  )
}
