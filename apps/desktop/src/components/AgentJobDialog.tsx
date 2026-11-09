import { useRef, useState, type ReactNode } from 'react'
import ReviewerPicker from './ReviewerPicker'
import { roleDevices } from '../lib/agentRoles'
import { agentDevices } from '../lib/plan'
import { useRail } from '../lib/rail'
import { useStore } from '../store'
import type { DeviceManifest, Worktree } from '../types'

/** The shared shell of the review and merge dialogs: agent picker, launch guard and errors. */
export default function AgentJobDialog({
  role,
  title,
  compact = false,
  source,
  sourceField,
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
  /** Preselects the global agents for this job; several may review at once. */
  role: 'review' | 'merge'
  title: string
  /** Chat shows only job inputs and a summary of the selected agents. */
  compact?: boolean
  source?: Worktree
  sourceField?: (props: { busy: boolean; clearError: () => void }) => ReactNode
  /** The job-specific fields are complete. */
  ready: boolean
  running: boolean
  runningText: string
  offlineText: string
  hint: ReactNode
  launch: (devices: DeviceManifest[]) => Promise<string>
  close: () => void
  launched: (sid: string) => void
  children: (props: { busy: boolean; clearError: () => void }) => ReactNode
}) {
  const devices = useStore((s) => s.devices)
  const connected = useStore((s) => s.serviceConnected)
  const roles = useStore((s) => s.agentRoles)
  const agents = agentDevices(devices)
  const multiple = role === 'review'
  // Devices may still be loading, so the role's presets are resolved until the user picks.
  const [picked, setPicked] = useState<string[]>()
  const [changingAgents, setChangingAgents] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const chosen = picked
    ? agents.filter((d) => picked.includes(d.id))
    : roleDevices(devices, roles, role)
  const device = chosen[0] as DeviceManifest | undefined
  const submit = async () => {
    if (pending.current || !ready || !source?.branch || !device || !connected || running) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      launched(await launch(chosen))
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
        {sourceField ? (
          sourceField({ busy, clearError: () => setError('') })
        ) : !compact ? (
          <label>
            Source branch <strong>{source?.branch}</strong>
            <code>{source?.path}</code>
          </label>
        ) : null}
        {children({ busy, clearError: () => setError('') })}
        {compact && (
          <p className="agent-job-summary">
            <span>Agents: {chosen.map((d) => d.name).join(', ') || 'None selected'}</span>{' '}
            <button
              type="button"
              disabled={busy || !agents.length}
              aria-expanded={changingAgents}
              onClick={() => setChangingAgents(!changingAgents)}
            >
              {changingAgents ? 'Done' : 'Change'}
            </button>
          </p>
        )}
        {(!compact || changingAgents) &&
          (multiple && agents.length > 1 ? (
            <fieldset className="agent-job-agents" disabled={busy}>
              <legend>Agents</legend>
              <ReviewerPicker
                agents={agents}
                selected={chosen.map((d) => d.id)}
                onChange={setPicked}
                disabled={busy}
              />
              {!compact && chosen.length > 1 && (
                <p className="hint">
                  Each agent reviews independently; their findings are combined for the fix.
                </p>
              )}
            </fieldset>
          ) : (
            <label>
              Agent
              <select
                aria-label="Agent"
                value={device?.id ?? ''}
                disabled={busy || !device}
                onChange={(e) => setPicked([e.target.value])}
              >
                {!device && <option value="">No agent presets</option>}
                {agents.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        {!compact && (
          <p className="hint">
            {roles[role]?.length
              ? 'Using global role defaults.'
              : `No global ${role} role default is set. Using the first agent preset.`}{' '}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                close()
                useRail.setState({ settings: 'roles' })
              }}
            >
              Edit role defaults…
            </button>
          </p>
        )}
        {!compact && <p className="hint">{hint}</p>}
        {!device && (
          <p role="status">
            {compact && !agents.length
              ? 'Add an agent preset in Settings.'
              : 'Choose at least one agent.'}
          </p>
        )}
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
            {busy ? 'Starting…' : compact ? `Start ${role}` : title}
          </button>
        </div>
      </form>
    </div>
  )
}
