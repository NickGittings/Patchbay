import WorkFeedback from './WorkFeedback'
import { workError } from '../lib/workBlocker'
import { useRef, useState, type ReactNode } from 'react'
import Dialog from './Dialog'
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
  source,
  sourceField,
  ready,
  running,
  runningText,
  blocker,
  onError,
  offlineText,
  hint,
  submitLabel,
  launch,
  close,
  launched,
  children,
}: {
  /** Preselects the global agents for this job; several may review at once. */
  role: 'review' | 'merge'
  title: string
  source?: Worktree
  sourceField?: (props: { busy: boolean; clearError: () => void }) => ReactNode
  /** The job-specific fields are complete. */
  ready: boolean
  running: boolean
  runningText: string
  blocker?: Error
  onError?: (error: Error) => void
  offlineText: string
  hint: ReactNode
  /** Replaces the default submit text when the launch does more than start the job. */
  submitLabel?: string
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error>()
  const pending = useRef(false)
  const chosen = picked
    ? agents.filter((d) => picked.includes(d.id))
    : roleDevices(devices, roles, role)
  const device = chosen[0] as DeviceManifest | undefined
  const submit = async () => {
    if (pending.current || !ready || !source?.branch || !device || !connected || running || blocker)
      return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      launched(await launch(chosen))
    } catch (e) {
      const error = workError(e)
      setError(error)
      onError?.(error)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <Dialog title={title} className="centered" onClose={close} dismissible={!busy}>
      <form
        className="task-dialog merge-agent-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {sourceField ? (
          sourceField({ busy, clearError: () => setError(undefined) })
        ) : (
          <label>
            Source branch <strong>{source?.branch}</strong>
            <code>{source?.path}</code>
          </label>
        )}
        {children({ busy, clearError: () => setError(undefined) })}
        {multiple && agents.length > 1 ? (
          <fieldset className="agent-job-agents" disabled={busy}>
            <legend>Agents</legend>
            <ReviewerPicker
              agents={agents}
              selected={chosen.map((d) => d.id)}
              onChange={setPicked}
              disabled={busy}
            />
            {chosen.length > 1 && (
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
        )}
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
        <p className="hint">{hint}</p>
        {!device && <p role="status">Choose at least one agent.</p>}
        {running && <p role="status">{runningText}</p>}
        {!connected && <p role="status">{offlineText}</p>}
        {(blocker || error) && <WorkFeedback error={(blocker ?? error)!} onOpenAuto={close} />}
        <div className="row">
          <span className="spacer" />
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !ready || !device || !connected || running || !!blocker}
          >
            {busy ? 'Starting…' : (submitLabel ?? title)}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
