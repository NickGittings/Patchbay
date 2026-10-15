import ReviewerPicker from './ReviewerPicker'
import { ROLE_LABELS } from '../lib/agentRoles'
import { agentDevices } from '../lib/plan'
import { useStore } from '../store'
import { AGENT_ROLES, type AgentRole } from '../types'

const DEFAULTS: Record<AgentRole, string> = {
  plan: 'the first agent preset',
  implement: 'the planner’s agent',
  review: 'the first agent preset',
  fix: 'the reviewer’s agent',
  merge: 'the first agent preset',
}

/** The project's agent per role; dialogs and Auto start from it and may override it per run. */
export default function AgentRolesPanel({ onClose }: { onClose: () => void }) {
  const devices = useStore((s) => s.devices)
  const roles = useStore((s) => s.agentRoles)
  const setRoles = useStore((s) => s.setAgentRoles)
  const agents = agentDevices(devices)
  const reviewers = (
    <fieldset key="review" className="agent-job-agents">
      <legend>Review</legend>
      <ReviewerPicker
        agents={agents}
        selected={roles.review ?? []}
        showMissing
        onChange={(next) => {
          const { review: _, ...rest } = roles
          setRoles(next.length ? { ...rest, review: next } : rest)
        }}
      />
      <p className="hint flush">
        {agents.filter((a) => roles.review?.includes(a.id)).length > 1
          ? 'These agents review independently, and the fix receives all their findings.'
          : 'Check several to have them review in parallel. None: the first agent preset.'}
      </p>
    </fieldset>
  )
  return (
    <div className="extension-overlay" onClick={onClose}>
      <div
        className="extensions-panel panel"
        role="dialog"
        aria-modal="true"
        aria-label="Agent roles"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="row">
          <h2>Agent roles</h2>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
        <p>
          Choose which agent does each job in this project. Review, merge and Auto dialogs start
          from these choices, and you can still change them for a single run. Several agents can
          review in parallel.
        </p>
        {AGENT_ROLES.map((role) => {
          if (role === 'review') return reviewers
          const id = roles[role]?.[0] ?? ''
          const missing = id && !agents.some((a) => a.id === id)
          return (
            <p key={role}>
              <label>
                {ROLE_LABELS[role]}{' '}
                <select
                  aria-label={ROLE_LABELS[role]}
                  value={id}
                  onChange={(e) => {
                    const { [role]: _, ...rest } = roles
                    setRoles(e.target.value ? { ...rest, [role]: [e.target.value] } : rest)
                  }}
                >
                  <option value="">Default: {DEFAULTS[role]}</option>
                  {missing && <option value={id}>{id} (not installed)</option>}
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            </p>
          )
        })}
      </div>
    </div>
  )
}
