import { useRail } from '../lib/rail'
import SettingsDialog, { SettingsSection } from './SettingsDialog'
import { Fragment, useId } from 'react'
import ReviewerPicker from './ReviewerPicker'
import { ROLE_LABELS } from '../lib/agentRoles'
import { agentDevices } from '../lib/plan'
import { useStore } from '../store'
import { AGENT_ROLES, SUBAGENT_COUNTS, type AgentRole } from '../types'

const DEFAULTS: Record<AgentRole, string> = {
  scan: 'Off',
  worker: 'Off',
  plan: 'the first agent preset',
  implement: 'the planner’s agent',
  review: 'the first agent preset',
  fix: 'the reviewer’s agent',
  merge: 'the first agent preset',
}

/** The project's agent per role; dialogs and Auto start from it and may override it per run. */
export default function AgentRolesPanel({ onClose }: { onClose: () => void }) {
  const subagentsId = useId()
  const devices = useStore((s) => s.devices)
  const roles = useStore((s) => s.agentRoles)
  const setRoles = useStore((s) => s.setAgentRoles)
  const subagents = useStore((s) => s.implementSubagents)
  const setSubagents = useStore((s) => s.setImplementSubagents)
  const agents = agentDevices(devices)
  const reviewers = (
    <div key="review" className="settings-field">
      <span title="Select several agents to review independently in parallel.">Review</span>
      <ReviewerPicker
        agents={agents}
        selected={roles.review ?? []}
        showMissing
        dropdown
        emptyLabel={`Default: ${DEFAULTS.review}`}
        onChange={(next) => {
          const { review: _, ...rest } = roles
          setRoles(next.length ? { ...rest, review: next } : rest)
        }}
      />
    </div>
  )
  return (
    <SettingsDialog
      title="Agent roles"
      subtitle="Default agents for this project"
      behavior="Changes apply immediately to this project. Individual runs can override these defaults."
      onClose={onClose}
    >
      <div className="settings-actions">
        <button onClick={() => useRail.setState({ settings: 'profiles' })}>
          Manage agent profiles…
        </button>
      </div>
      <SettingsSection title="Role defaults">
        {AGENT_ROLES.map((role) => {
          if (role === 'review') return reviewers
          if (role === 'scan' || role === 'worker')
            return (
              <div key={role} className="settings-field">
                <span>{ROLE_LABELS[role]}</span>
                <ReviewerPicker
                  label={ROLE_LABELS[role]}
                  agents={agents}
                  selected={roles[role] ?? []}
                  showMissing
                  dropdown
                  emptyLabel="Off"
                  onChange={(next) => setRoles({ ...roles, [role]: next })}
                />
              </div>
            )
          const id = roles[role]?.[0] ?? ''
          const missing = id && !agents.some((a) => a.id === id)
          return (
            <Fragment key={role}>
              <label className="settings-field">
                {ROLE_LABELS[role]}
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
              {role === 'implement' && (
                <div className="settings-field">
                  <label
                    title="Ask the implementation agent to split the plan across parallel subagents, if supported."
                    htmlFor={subagentsId}
                  >
                    Subagents
                  </label>
                  <select
                    disabled={!!roles.worker?.length}
                    id={subagentsId}
                    value={subagents}
                    onChange={(e) => setSubagents(Number(e.target.value))}
                  >
                    {SUBAGENT_COUNTS.map((n) => (
                      <option key={n} value={n}>
                        {n || 'Off'}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </Fragment>
          )
        })}
      </SettingsSection>
    </SettingsDialog>
  )
}
