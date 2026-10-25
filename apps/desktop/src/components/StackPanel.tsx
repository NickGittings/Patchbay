import { useMemo, useState } from 'react'
import { linkedWithin, stackSetup, type DevelopmentSuggestion } from '../lib/stack'
import { validatorKey } from '../lib/validators'
import { planTerminals } from '../lib/plan'
import { roleTerminal } from '../lib/agentRoles'
import {
  applyStackProposal,
  discardStackProposal,
  stackAgentSession,
  startStackAgent,
  useStackProposals,
} from '../lib/stackAgent'
import type { PendingStack, ProposedStackTerminal } from '../types'
import { mapEditsBlocked } from '../lib/mapSave'
import { useStore, type FlowNode } from '../store'
import { runGraphAction, stopGroup } from '../lib/actions'
import { statusTitle, terminalStatus } from '../lib/display'
import { parseSessionId, sessionId, type ComponentGroup } from '../types'

const MAX_TIMEOUT = 3600

/** Whole seconds within the range `ActionPlan::build` accepts, or `null` while unusable. */
function parseTimeout(text: string) {
  const seconds = Math.round(Number(text))
  return text.trim() && Number.isFinite(seconds)
    ? Math.max(1, Math.min(MAX_TIMEOUT, seconds))
    : null
}

/** Edits a draft and commits on blur or Enter, so typing isn't rewritten mid-way. */
function TimeoutField({ group }: { group: ComponentGroup }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    const seconds = draft === null ? null : parseTimeout(draft)
    if (seconds !== null && seconds !== group.readinessTimeoutSeconds)
      useStore.getState().updateGroup(group.id, { readinessTimeoutSeconds: seconds })
    setDraft(null)
  }
  return (
    <label title="How long each task may take to print its “ready when” text">
      Readiness timeout (seconds)
      <input
        type="number"
        min={1}
        max={MAX_TIMEOUT}
        step={1}
        value={draft ?? group.readinessTimeoutSeconds}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setDraft(null)
        }}
      />
    </label>
  )
}

/** The member's Development terminals in the active worktree: what a stack starts. */
function DevelopmentStatus({ node }: { node: FlowNode }) {
  const task = useStore((s) => s.activeTask)
  const sessions = useStore((s) => s.sessions)
  const terminals = node.data.terminals.filter((t) => t.action === 'development')
  if (!terminals.length) return <span className="hint flush">no Development terminal</span>
  return terminals.map((t) => {
    const status = terminalStatus(t.kind, sessions[sessionId(node.id, t.id, task)])
    return (
      <span
        key={t.id}
        className={`stack-terminal health-${status.health}`}
        title={statusTitle(status, t.command || 'interactive shell')}
      >
        <span className="status-dot" />
        {t.name}
      </span>
    )
  })
}

function GroupEditor({ group }: { group: ComponentGroup }) {
  const nodes = useStore((s) => s.nodes)
  const busy = useStore((s) => s.graphActionBusy)
  const { updateGroup, removeGroup, toggleHighlight } = useStore.getState()
  const [stopping, setStopping] = useState(false)
  return (
    <details className="component-group" open>
      <summary>
        {group.name} <span className="count">{group.componentIds.length}</span>
      </summary>
      <label>
        Name
        <input
          aria-label="Stack name"
          value={group.name}
          onChange={(e) => updateGroup(group.id, { name: e.target.value })}
        />
      </label>
      <div className="group-members">
        {nodes.map((node) => (
          <label key={node.id} className="group-option">
            <input
              type="checkbox"
              checked={group.componentIds.includes(node.id)}
              onChange={(e) =>
                updateGroup(group.id, {
                  componentIds: e.target.checked
                    ? [...group.componentIds, node.id]
                    : group.componentIds.filter((id) => id !== node.id),
                })
              }
            />
            {node.data.name}
            {group.componentIds.includes(node.id) && <DevelopmentStatus node={node} />}
          </label>
        ))}
      </div>
      <label className="group-option">
        <input
          type="checkbox"
          checked={group.orderedStartup}
          onChange={(e) => updateGroup(group.id, { orderedStartup: e.target.checked })}
        />
        Start dependencies first
      </label>
      <TimeoutField group={group} />
      <div className="row">
        <button
          disabled={busy || stopping || !group.componentIds.length}
          onClick={() => void runGraphAction({ kind: 'startGroup', groupId: group.id })}
        >
          Start
        </button>
        <button
          disabled={stopping}
          title="Stop what this stack started in the current worktree; shared terminals keep running"
          onClick={async () => {
            setStopping(true)
            await stopGroup(group.id)
            setStopping(false)
          }}
        >
          Stop
        </button>
        <button
          title="Use this stack as the planner scope"
          onClick={() => {
            useStore.getState().clearHighlights()
            group.componentIds.forEach(toggleHighlight)
            useStore.getState().setView('plan')
          }}
        >
          Plan
        </button>
        <button
          disabled={busy || stopping}
          onClick={async () => {
            setStopping(true)
            if (await stopGroup(group.id, true)) removeGroup(group.id)
            setStopping(false)
          }}
        >
          Delete
        </button>
      </div>
    </details>
  )
}

/**
 * Offers the map's dev servers for a stack: marks the ticked ones Development (with the text
 * they print once ready) and, when there is no stack yet, creates one of them.
 */
function StackSuggestions() {
  const nodes = useStore((s) => s.nodes)
  const edges = useStore((s) => s.edges)
  const groups = useStore((s) => s.groups)
  const declined = useStore((s) => s.stackDeclined)
  const blocked = useStore((s) => !!s.project && mapEditsBlocked(s.projects[s.project.id]))
  const { updateTerminal, addGroup, declineStack, restoreStack } = useStore.getState()
  // Unticked rows and edited ready texts; dev servers are cheap to undo, so all start ticked.
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set())
  const [ready, setReady] = useState<Record<string, string>>({})
  const [done, setDone] = useState('')
  const setup = useMemo(() => stackSetup(nodes, declined), [nodes, declined])
  const key = (s: DevelopmentSuggestion) => validatorKey(s.componentId, s.terminalId)
  const chosen = setup.suggestions.filter((s) => !unticked.has(key(s)))
  const restore = !!setup.declined && (
    <button onClick={restoreStack}>
      Show {setup.declined === 1 ? '1 dismissed server' : `${setup.declined} dismissed servers`}
    </button>
  )
  const creates = !groups.length
  if (!setup.suggestions.length)
    return done || restore ? (
      <div className="task-action-result">
        {done && (
          <p className="hint flush" role="status">
            {done}
          </p>
        )}
        {restore && <div className="row">{restore}</div>}
      </div>
    ) : null
  return (
    <div className="task-action-result stack-suggestions">
      <strong>{creates ? 'Set up a stack' : 'More dev servers'}</strong>
      <p className="hint flush">
        These look like dev servers or watchers. Ready when is text each prints once it is up, so
        what depends on it starts after; leave it empty to start without waiting.
      </p>
      <div className="validator-suggestions">
        {setup.suggestions.map((s) => (
          <div key={key(s)} className="validator-suggestion">
            <input
              type="checkbox"
              aria-label={`Use ${s.componentName} › ${s.terminalName}`}
              checked={!unticked.has(key(s))}
              onChange={(e) => {
                const on = e.target.checked
                setUnticked((prev) => {
                  const next = new Set(prev)
                  if (on) next.delete(key(s))
                  else next.add(key(s))
                  return next
                })
              }}
            />
            <span className="validator-suggestion-details">
              <span>
                {s.componentName} › {s.terminalName}
              </span>
              <code>{s.command}</code>
              <input
                aria-label={`${s.componentName} › ${s.terminalName} ready when`}
                placeholder="Ready when (optional)"
                value={ready[key(s)] ?? s.readyWhen}
                onChange={(e) => setReady((prev) => ({ ...prev, [key(s)]: e.target.value }))}
              />
            </span>
          </div>
        ))}
      </div>
      <div className="row">
        <button
          disabled={blocked || !chosen.length}
          title={blocked ? 'Resolve the map conflict or project recovery first' : undefined}
          onClick={() => {
            for (const s of chosen)
              updateTerminal(s.componentId, s.terminalId, {
                action: 'development',
                readyWhen: (ready[key(s)] ?? s.readyWhen).trim(),
              })
            if (creates) {
              const members = [...new Set([...setup.ready, ...chosen.map((s) => s.componentId)])]
              addGroup('Local stack', members, linkedWithin(members, edges))
            }
            setDone(
              creates
                ? 'Created “Local stack”. Start it below.'
                : `Marked ${chosen.length === 1 ? 'a terminal' : `${chosen.length} terminals`} as Development. Add their components to a stack below.`,
            )
          }}
        >
          {creates ? 'Create stack' : 'Mark as Development'}
        </button>
        <button onClick={() => declineStack(setup.suggestions.map(key))}>Dismiss</button>
        {restore}
      </div>
    </div>
  )
}

/** A proposed terminal's identity, unique within a submission (the backend refuses repeats). */
const proposedKey = (t: ProposedStackTerminal) =>
  `${t.component}\n${t.terminal ?? `new:${t.name?.trim().toLowerCase()}`}`

/** The agent's proposed stack, every terminal ticked, to apply or discard. */
function StackReview({ pending, projectId }: { pending: PendingStack; projectId: string }) {
  const nodes = useStore((s) => s.nodes)
  const busy = useStackProposals((s) => !!s.busy[projectId])
  const blocked = useStore((s) => mapEditsBlocked(s.projects[projectId]))
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set())
  const chosen = pending.terminals.filter((t) => !unticked.has(proposedKey(t)))
  const name = (id: string) => nodes.find((n) => n.id === id)?.data.name ?? id
  const terminalOf = (component: string, id: string) =>
    nodes.find((n) => n.id === component)?.data.terminals.find((t) => t.id === id)
  return (
    <div className="task-action-result stack-suggestions" aria-label="Proposed stack">
      <strong>Proposed stack · {pending.name}</strong>
      <p className="hint flush">
        {pending.orderedStartup
          ? 'Dependencies start first, each waiting until it prints its ready text.'
          : 'Everything starts at once.'}{' '}
        Applying marks these terminals Development and adds their components to the stack.
      </p>
      <div className="validator-suggestions">
        {pending.terminals.map((t) => {
          const key = proposedKey(t)
          const existing = t.terminal ? terminalOf(t.component, t.terminal) : undefined
          // Applying keeps an existing terminal's ready text when the agent gives none.
          const ready = t.readyWhen || existing?.readyWhen
          return (
            <label key={key} className="validator-suggestion">
              <input
                type="checkbox"
                checked={!unticked.has(key)}
                onChange={(e) => {
                  const on = e.target.checked
                  setUnticked((prev) => {
                    const next = new Set(prev)
                    if (on) next.delete(key)
                    else next.add(key)
                    return next
                  })
                }}
              />
              <span className="validator-suggestion-details">
                <span>
                  {name(t.component)} ›{' '}
                  {t.terminal ? (existing?.name ?? t.terminal) : `${t.name} (new)`}
                </span>
                {t.command && <code>{t.command}</code>}
                <span className="hint flush">
                  {ready ? `Ready when “${ready}”` : 'Starts without waiting'}
                </span>
                <span className="hint flush">{t.reason}</span>
              </span>
            </label>
          )
        })}
      </div>
      <div className="row">
        <button
          disabled={busy || blocked || !chosen.length}
          title={blocked ? 'Resolve the map conflict or project recovery first' : undefined}
          onClick={() => void applyStackProposal(pending, chosen, projectId)}
        >
          Apply
        </button>
        <button disabled={busy} onClick={() => void discardStackProposal(projectId, pending.id)}>
          Discard
        </button>
      </div>
    </div>
  )
}

/** Detection with an agent, for stacks the rules above can't see, and its proposal's review. */
function StackAgent({ projectId }: { projectId: string }) {
  const devices = useStore((s) => s.devices)
  const roles = useStore((s) => s.agentRoles)
  const pending = useStackProposals((s) => s.pending[projectId])
  const running = useStore((s) => !!s.sessions[stackAgentSession(projectId)]?.running)
  const blocked = useStore((s) => mapEditsBlocked(s.projects[projectId]))
  const presets = planTerminals(devices)
  const [choice, setChoice] = useState<string>()
  const preset =
    presets.find((t) => t.id === choice) ?? roleTerminal(devices, roles, 'plan') ?? presets[0]
  if (pending) return <StackReview key={pending.id} pending={pending} projectId={projectId} />
  return (
    <div className="row stack-agent">
      {presets.length > 1 && (
        <select
          aria-label="Stack detection agent"
          value={preset?.id ?? ''}
          onChange={(e) => setChoice(e.target.value)}
        >
          {presets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      <button
        disabled={!preset || (blocked && !running)}
        title={
          blocked && !running
            ? 'Resolve the map conflict or project recovery first'
            : 'An agent reads the project (README, scripts, docker-compose…) and proposes a stack for you to review'
        }
        onClick={() => preset && void startStackAgent(projectId, preset)}
      >
        {running ? 'Show stack detection' : 'Detect stack with an agent…'}
      </button>
    </div>
  )
}

/**
 * Stacks (`Project.groups`): sets of components whose Development terminals start together,
 * dependencies first when ordered, each waiting until it is ready.
 */
export default function StackPanel() {
  const projectId = useStore((s) => s.project?.id)
  const groups = useStore((s) => s.groups)
  const nodes = useStore((s) => s.nodes)
  const report = useStore((s) => s.graphActionReport)
  const [name, setName] = useState('')
  return (
    <section className="component-groups" aria-label="Stacks">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim()) return
          const selected = nodes.filter(
            (n) => n.selected || n.id === useStore.getState().selectedId,
          )
          useStore.getState().addGroup(
            name.trim(),
            selected.map((n) => n.id),
          )
          setName('')
        }}
      >
        <input
          aria-label="New stack name"
          placeholder="New stack name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" disabled={!name.trim()}>
          Add
        </button>
      </form>
      <p className="hint flush">
        A stack starts its components’ Development terminals together, such as a database, an API
        and a web app. Mark terminals as Development in the component inspector. New stacks start
        with the selected components.
      </p>
      <StackSuggestions />
      {projectId && <StackAgent projectId={projectId} />}
      {groups.map((group) => (
        <GroupEditor key={group.id} group={group} />
      ))}
      {report && (
        <details className="action-results" open>
          <summary>Last action · {report.results.length} tasks</summary>
          {report.results.map((result) => (
            <button
              className="action-result"
              key={result.sessionId}
              data-session={result.sessionId}
              onClick={() => {
                // Navigation, where these results and the dock live.
                const { componentId, task } = parseSessionId(result.sessionId)
                const s = useStore.getState()
                s.setActiveTask(task)
                s.select(componentId)
                s.setActiveSession(result.sessionId)
                s.setView('navigation')
              }}
            >
              <span>{resultLabel(result.sessionId)}</span>
              <strong
                className={
                  result.outcome === 'failed' || result.outcome === 'stopped' ? result.outcome : ''
                }
                title={result.message}
              >
                {result.outcome}
                {result.exitCode !== null ? ` (${result.exitCode})` : ''}
              </strong>
            </button>
          ))}
          {report.plan.skipped.map((id) => (
            <p className="hint flush" key={id}>
              {nodes.find((n) => n.id === id)?.data.name ?? id}: no configured tasks
            </p>
          ))}
        </details>
      )}
    </section>
  )
}

/** "Component › Terminal" for a session id, which is opaque. */
function resultLabel(sid: string) {
  const { componentId, terminalId } = parseSessionId(sid)
  const node = useStore.getState().nodes.find((n) => n.id === componentId)
  const terminal = node?.data.terminals.find((t) => t.id === terminalId)
  return `${node?.data.name ?? componentId} › ${terminal?.name ?? terminalId}`
}
