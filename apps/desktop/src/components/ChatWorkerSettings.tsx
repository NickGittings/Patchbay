import { useState } from 'react'
import { projectOf, useStore } from '../store'
import { controlTeam, requireTeamPreset, useChatTeams, type ChatTeam } from '../lib/chatTeams'
import { roleDevices } from '../lib/agentRoles'
import { planTerminals } from '../lib/plan'
import { SettingsSection } from './SettingsDialog'

export default function ChatWorkerSettings() {
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const team = useChatTeams((s) => s.teams[projectId ?? '']?.find((t) => t.task === task))
  return team ? <WorkerSettings key={team.id} team={team} /> : null
}

function WorkerSettings({ team }: { team: ChatTeam }) {
  const devices = useStore((s) => s.devices)
  const roles = useStore((s) => s.agentRoles)
  const workersEnabled = roleDevices(devices, roles, 'worker').length > 0
  const [limit, setLimit] = useState(team.limit)
  const [presets, setPresets] = useState(team.workers.map((w) => w.id))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const choices = [...team.workers, ...planTerminals(devices)].filter(
    (p, i, all) => all.findIndex((other) => other.id === p.id) === i,
  )
  return (
    <SettingsSection title="Sub-builders for this worktree">
      {!workersEnabled && (
        <p className="hint">
          Sub-builders are off. Choose agents under Role defaults → Sub-builders to let the lead
          start them.
        </p>
      )}
      <label className="settings-field">
        Concurrent sub-builders
        <input
          aria-label="Concurrent sub-builders"
          type="number"
          min={1}
          max={8}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
        />
      </label>
      {choices.map((p) => (
        <label className="settings-field" key={p.id}>
          <input
            type="checkbox"
            checked={presets.includes(p.id)}
            onChange={(e) =>
              setPresets(
                e.target.checked ? [...presets, p.id] : presets.filter((id) => id !== p.id),
              )
            }
          />
          {p.name}
        </label>
      ))}
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError('')
          try {
            const project = projectOf(team.projectId)
            if (!project) throw new Error('Open this project before changing sub-builders')
            const workers = choices.filter((p) => presets.includes(p.id))
            if (!workers.length) throw new Error('Choose at least one sub-builder preset')
            for (const worker of workers) await requireTeamPreset(worker, project, team.task)
            await controlTeam(team, { kind: 'settings', workers, limit })
          } catch (e) {
            setError(String(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        Save sub-builder settings
      </button>
      {error && <p role="alert">{error}</p>}
    </SettingsSection>
  )
}
