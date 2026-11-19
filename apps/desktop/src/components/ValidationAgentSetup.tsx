import { useState } from 'react'
import { useStore } from '../store'
import { planTerminals } from '../lib/plan'
import { roleTerminal } from '../lib/agentRoles'
import { mapEditsBlocked } from '../lib/mapSave'
import { revealTerminal } from '../lib/attention'
import { selectPanel } from '../lib/rail'
import { useGraphActionRunning } from '../lib/graphActivity'
import { stackAgentSession, startStackAgent, useStackProposals } from '../lib/stackAgent'
import {
  applyValidationProposal,
  discardValidationProposal,
  useValidationProposals,
} from '../lib/validationAgent'
import { MAP_SCOPE, type MissingCheck, type PendingValidation, type ProposedCheck } from '../types'

/**
 * Proposed checks with their evidence, each ticked unless in `unchecked`, and why the remaining
 * components have none. `onToggle` is omitted for a read-only review.
 */
export function CheckList({
  checks,
  missing,
  unchecked,
  onToggle,
}: {
  checks: ProposedCheck[]
  missing: MissingCheck[]
  unchecked: number[]
  onToggle?: (index: number, on: boolean) => void
}) {
  const nodes = useStore((s) => s.nodes)
  const name = (id: string) => nodes.find((n) => n.id === id)?.data.name ?? id
  return (
    <>
      {checks.map((t, i) => (
        <label className="validator-suggestion" key={i}>
          <input
            type="checkbox"
            checked={!unchecked.includes(i)}
            disabled={!onToggle}
            onChange={(e) => onToggle?.(i, e.target.checked)}
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
      {missing.map((m) => (
        <p className="hint" key={m.component}>
          No checks for {name(m.component)}: {m.reason}
        </p>
      ))}
    </>
  )
}

/** A submission the retired validation discovery agent left, reviewed one last time. */
function LegacyReview({ pending, projectId }: { pending: PendingValidation; projectId: string }) {
  const [unchecked, setUnchecked] = useState<number[]>([])
  const busy = useValidationProposals((s) => !!s.busy[projectId])
  const blocked = useStore((s) => mapEditsBlocked(s.projects[projectId]))
  const running = useGraphActionRunning()
  const chosen = pending.terminals.filter((_, i) => !unchecked.includes(i))
  return (
    <div className="task-action-result">
      <strong>Proposed validation checks</strong>
      <CheckList
        checks={pending.terminals}
        missing={pending.missing}
        unchecked={unchecked}
        onToggle={(i, on) =>
          setUnchecked((prev) => (on ? prev.filter((x) => x !== i) : [...prev, i]))
        }
      />
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
          Apply and run checks
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

/**
 * Run → Set up validation: run & test detection for chosen components, whose proposed checks are
 * reviewed with the rest of its proposal in the Stack panel.
 */
export default function ValidationAgentSetup({ projectId }: { projectId: string }) {
  const nodes = useStore((s) => s.nodes)
  const devices = useStore((s) => s.devices)
  const roles = useStore((s) => s.agentRoles)
  const legacy = useValidationProposals((s) => s.pending[projectId])
  const pending = useStackProposals((s) => s.pending[projectId])
  const running = useStore((s) => !!s.sessions[stackAgentSession(projectId)]?.running)
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
        title={
          !running && pending ? 'Review the waiting run & test proposal in the Stack panel' : ''
        }
        onClick={() => {
          if (running) {
            revealTerminal({ sid: stackAgentSession(projectId), componentId: MAP_SCOPE })
            return
          }
          const s = useStore.getState()
          setSelected(s.nodes.filter((n) => n.selected || n.id === s.selectedId).map((n) => n.id))
          setPicking(true)
        }}
      >
        {running ? 'Show run & test detection' : 'Configure checks with an agent…'}
      </button>
      {!running && pending && (
        <p className="hint">
          Run & test detection proposed a setup.{' '}
          <button className="link" onClick={() => selectPanel('stack')}>
            Review it in the Stack panel
          </button>
        </p>
      )}
      {picking && (
        <div>
          <p className="hint">
            Choose components. The agent reads existing tooling and proposes checks, with the rest
            of the run & test setup, for review in the Stack panel.
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
            aria-label="Run & test detection agent"
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
              if (preset) void startStackAgent(projectId, preset, { componentIds: selected })
              setPicking(false)
            }}
          >
            Discover checks
          </button>
          <button onClick={() => setPicking(false)}>Cancel</button>
        </div>
      )}
      {legacy && <LegacyReview key={legacy.id} pending={legacy} projectId={projectId} />}
    </div>
  )
}
