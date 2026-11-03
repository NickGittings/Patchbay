import { useState } from 'react'
import { useStore } from '../store'
import { planTerminals } from '../lib/plan'
import { roleTerminal } from '../lib/agentRoles'
import { mapEditsBlocked } from '../lib/mapSave'
import {
  applyValidationProposal,
  discardValidationProposal,
  startValidationAgent,
  useValidationProposals,
  validationAgentSession,
} from '../lib/validationAgent'
import type { PendingValidation } from '../types'

function Review({ pending, projectId }: { pending: PendingValidation; projectId: string }) {
  const [unchecked, setUnchecked] = useState<number[]>([])
  const nodes = useStore((s) => s.nodes)
  const busy = useValidationProposals((s) => !!s.busy[projectId])
  const blocked = useStore((s) => mapEditsBlocked(s.projects[projectId]))
  const running = useStore(
    (s) =>
      s.graphActionBusy ||
      Object.values(s.taskActivities).some(
        (a) =>
          a.state === 'running' &&
          ['validate', 'validateChanged', 'validateSelected', 'environmentStart'].includes(
            a.action.kind,
          ),
      ),
  )
  const absent = useStore((s) => s.projects[projectId]?.fingerprint === 'absent')
  const chosen = pending.terminals.filter((_, i) => !unchecked.includes(i))
  const name = (id: string) => nodes.find((n) => n.id === id)?.data.name ?? id
  return (
    <div className="task-action-result">
      <strong>Proposed validation checks</strong>
      {pending.terminals.map((t, i) => (
        <label className="validator-suggestion" key={i}>
          <input
            type="checkbox"
            checked={!unchecked.includes(i)}
            onChange={(e) =>
              setUnchecked((prev) =>
                e.target.checked ? prev.filter((x) => x !== i) : [...prev, i],
              )
            }
          />
          <span className="validator-suggestion-details">
            <span>
              {name(t.component)} › {t.name ?? t.terminal}
            </span>
            <code>{t.command}</code>
            <span className="hint">Execution folder: {t.path || '.'}</span>
            <span className="hint">{t.reason}</span>
          </span>
        </label>
      ))}
      {pending.missing.map((m) => (
        <p className="hint" key={m.component}>
          {name(m.component)}: {m.reason}
        </p>
      ))}
      {absent && (
        <p className="hint">
          After applying, choose Create map configuration in the Project panel to keep these checks.
        </p>
      )}
      <div className="row">
        <button
          disabled={busy || blocked || !chosen.length}
          onClick={() => void applyValidationProposal(pending, chosen, projectId)}
        >
          Apply
        </button>
        <button
          disabled={busy || blocked || running || !chosen.length}
          onClick={() => void applyValidationProposal(pending, chosen, projectId, true)}
        >
          Apply and run
        </button>
        <button
          disabled={busy}
          onClick={() => void discardValidationProposal(projectId, pending.id)}
        >
          Discard
        </button>
      </div>
    </div>
  )
}

export default function ValidationAgentSetup({ projectId }: { projectId: string }) {
  const nodes = useStore((s) => s.nodes)
  const devices = useStore((s) => s.devices)
  const roles = useStore((s) => s.agentRoles)
  const pending = useValidationProposals((s) => s.pending[projectId])
  const running = useStore((s) => !!s.sessions[validationAgentSession(projectId)]?.running)
  const blocked = useStore((s) => mapEditsBlocked(s.projects[projectId]))
  const [picking, setPicking] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [choice, setChoice] = useState<string>()
  const presets = planTerminals(devices)
  const preset =
    presets.find((t) => t.id === choice) ?? roleTerminal(devices, roles, 'plan') ?? presets[0]
  return (
    <div className="task-action-result">
      <button
        disabled={blocked || (!running && !!pending)}
        onClick={() => {
          if (running && preset) {
            void startValidationAgent(projectId, preset, [])
            return
          }
          const s = useStore.getState()
          setSelected(s.nodes.filter((n) => n.selected || n.id === s.selectedId).map((n) => n.id))
          setPicking(true)
        }}
      >
        {running ? 'Show validation discovery' : 'Configure checks with an agent…'}
      </button>
      {picking && (
        <div>
          <p className="hint">
            Choose components. The agent reads existing tooling and proposes checks for review.
          </p>
          {nodes.map((n) => (
            <label className="validator-suggestion" key={n.id}>
              <input
                type="checkbox"
                checked={selected.includes(n.id)}
                onChange={(e) =>
                  setSelected((prev) =>
                    e.target.checked ? [...prev, n.id] : prev.filter((x) => x !== n.id),
                  )
                }
              />
              {n.data.name}
            </label>
          ))}
          <select
            aria-label="Validation discovery agent"
            value={preset?.id ?? ''}
            onChange={(e) => setChoice(e.target.value)}
          >
            {presets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            disabled={!preset || !selected.length || blocked}
            onClick={() => {
              if (preset) void startValidationAgent(projectId, preset, selected)
              setPicking(false)
            }}
          >
            Discover checks
          </button>
          <button onClick={() => setPicking(false)}>Cancel</button>
        </div>
      )}
      {pending && <Review key={pending.id} pending={pending} projectId={projectId} />}
    </div>
  )
}
