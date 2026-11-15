import { useState } from 'react'
import { useStore } from '../store'
import { councilSettings, cancelCouncil, savedCouncil } from '../lib/council'
import { commandProfile } from '../lib/agentProfiles'
import { agentDevices } from '../lib/plan'
import { controlTeam, useChatTeams } from '../lib/chatTeams'
import { SettingsSection } from './SettingsDialog'

export default function CouncilSettings() {
  const settings = useStore((s) => s.workspaceSettings)
  const roles = useStore((s) => s.agentRoles)
  const devices = useStore((s) => s.devices)
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const teams = useChatTeams((s) => s.teams)
  const [error, setError] = useState('')
  const value = councilSettings(settings.reviewCouncil, roles.review)
  const agents = agentDevices(devices).filter((a) => !!(a.adapter || commandProfile(a.command)))
  const valid =
    value.members.length >= 2 && value.members.every((id) => agents.some((a) => a.id === id))
  const update = (next: typeof value) =>
    useStore.setState((s) => ({
      workspaceSettings: {
        ...s.workspaceSettings,
        reviewCouncil: { ...next, enabled: next.enabled && next.members.length >= 2 },
      },
    }))
  const team = teams[projectId ?? '']?.find((t) => t.task === task)
  const running =
    team?.requests?.filter(
      (r) =>
        r.action === 'startCouncilReview' &&
        ['queued', 'starting', 'running', 'waiting', 'failed', 'completed'].includes(r.state),
    ) ?? []
  return (
    <SettingsSection title="Review council">
      <label className="settings-field">
        <input
          type="checkbox"
          checked={value.enabled}
          disabled={!valid && !value.enabled}
          onChange={(e) => update({ ...value, enabled: e.target.checked })}
        />
        Allow the lead to convene a council
      </label>
      <p className="hint">
        Council reviews use more tokens and may increase costs or consume subscription limits
        faster. Each selected agent reviews the changes separately, and the lead summarizes their
        findings.
      </p>
      <p className="hint">
        Choose at least two presets. You can mix models and providers. Changes apply to subsequent
        council runs.
      </p>
      {[...new Set([...agents.map((a) => a.id), ...value.members])].map((id) => {
        const agent = agents.find((a) => a.id === id)
        const profile = agent && commandProfile(agent.command)
        const model =
          profile?.model ||
          agent?.command.match(/(?:--model(?:=|\s+)|-m\s+)([^\s]+)/)?.[1] ||
          'provider default'
        return (
          <label className="settings-field" key={id}>
            <input
              type="checkbox"
              checked={value.members.includes(id)}
              onChange={(e) =>
                update({
                  ...value,
                  members: e.target.checked
                    ? [...value.members, id]
                    : value.members.filter((m) => m !== id),
                })
              }
            />
            {agent
              ? `${agent.name} · ${profile?.openRouter ? 'OpenRouter' : (agent.adapter ?? 'profile')} · ${model}`
              : `${id} (unavailable)`}
          </label>
        )
      })}
      <label className="settings-field">
        Concurrent reviewers
        <select
          value={value.concurrency}
          onChange={(e) => update({ ...value, concurrency: Number(e.target.value) })}
        >
          {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      {!valid && (
        <p role="alert">Select at least two available presets to enable council reviews.</p>
      )}
      {running.map((request) => (
        <div key={request.id}>
          <p role="status">Council: {request.state}</p>
          {savedCouncil(request)?.members.map((m) => (
            <p key={m.preset.id}>
              {m.preset.name}: {m.state}
              {m.error && ` — ${m.error}`}
            </p>
          ))}
          {!['failed', 'completed'].includes(request.state) && (
            <button
              onClick={() => void cancelCouncil(team!, request).catch((e) => setError(String(e)))}
            >
              Cancel council
            </button>
          )}
          {request.state === 'failed' && (
            <button
              onClick={() =>
                void controlTeam(team!, { kind: 'retryCouncil', id: request.id }).catch((e) =>
                  setError(String(e)),
                )
              }
            >
              Run council again
            </button>
          )}
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </SettingsSection>
  )
}
