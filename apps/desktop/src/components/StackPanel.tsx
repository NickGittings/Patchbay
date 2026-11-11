import PanelSection, { PanelDetails } from './PanelSection'
import WorktreeSetupPanel from './WorktreeSetupPanel'
import WorktreeSetupStatus from './tasks/WorktreeSetupStatus'
import { taskPassed } from '../lib/autoSettings'
import Menu, { MenuItem } from './Menu'
import { useMemo, useState } from 'react'
import {
  linkedWithin,
  proposedPatch,
  proposedTerminal,
  stackSetup,
  type DevelopmentSuggestion,
} from '../lib/stack'
import { validatorKey } from '../lib/validators'
import { planTerminals } from '../lib/plan'
import { roleTerminal } from '../lib/agentRoles'
import { revealTerminal } from '../lib/attention'
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
import { MAP_SCOPE, parseSessionId, sessionId, type ComponentGroup } from '../types'

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
  if (!terminals.length) return null
  return terminals.map((t) => {
    const status = terminalStatus(t.kind, sessions[sessionId(node.id, t.id, task)])
    return (
      <span
        key={t.id}
        className={`stack-terminal health-${status.health}`}
        title={`${t.name}: ${statusTitle(status, t.command || 'interactive shell')}`}
      >
        <span className="status-dot" />
      </span>
    )
  })
}

/** Edits the same terminal definitions used by the Inspector and every stack. */
function StackTerminals({ node }: { node: FlowNode }) {
  const { updateTerminal, addTerminal } = useStore.getState()
  return (
    <div className="stack-terminal-editor" aria-label={`${node.data.name} Development terminals`}>
      <strong>{node.data.name}</strong>
      <p className="hint">Commands run in this component’s folder in the selected worktree.</p>
      {node.data.terminals
        .filter((t) => t.kind === 'task' && t.action !== 'validation')
        .map((t) => (
          <div className="terminal-row" key={t.id}>
            <label className="group-option">
              <input
                type="checkbox"
                checked={t.action === 'development'}
                onChange={(e) =>
                  updateTerminal(node.id, t.id, {
                    action: e.target.checked ? 'development' : undefined,
                  })
                }
              />
              Include {t.name} in Development startup
            </label>
            <label>
              Terminal name
              <input
                aria-label={`${node.data.name} › ${t.id} name`}
                value={t.name}
                onChange={(e) => updateTerminal(node.id, t.id, { name: e.target.value })}
              />
            </label>
            <label>
              Command
              <input
                aria-label={`${node.data.name} › ${t.id} command`}
                placeholder="npm ci && npm run build && npm start"
                value={t.command}
                onChange={(e) => updateTerminal(node.id, t.id, { command: e.target.value })}
              />
            </label>
            <label>
              Ready when
              <input
                aria-label={`${node.data.name} › ${t.id} ready when`}
                placeholder="Output text to wait for (optional)"
                value={t.readyWhen ?? ''}
                onChange={(e) => updateTerminal(node.id, t.id, { readyWhen: e.target.value })}
              />
            </label>
          </div>
        ))}
      <button
        onClick={() => {
          const id = addTerminal(node.id, null, false)
          updateTerminal(node.id, id, { name: 'Development', action: 'development' })
        }}
      >
        Add Development terminal to {node.data.name}
      </button>
    </div>
  )
}

function GroupEditor({ group }: { group: ComponentGroup }) {
  const nodes = useStore((s) => s.nodes)
  const busy = useStore((s) => s.graphActionBusy)
  const { updateGroup, removeGroup, toggleHighlight } = useStore.getState()
  const [stopping, setStopping] = useState(false)
  const [editing, setEditing] = useState(!group.componentIds.length)
  const blocked = useStore((s) => !!s.project && mapEditsBlocked(s.projects[s.project.id]))
  return (
    <section className="stack-card">
      <div className="panel-section-head">
        <strong>{group.name}</strong>
        <Menu label="⋯" triggerLabel={`Stack actions for ${group.name}`} caret={false} portal>
          <MenuItem onClick={() => setEditing(!editing)}>Edit</MenuItem>
          <MenuItem
            onClick={() => {
              useStore.getState().clearHighlights()
              group.componentIds.forEach(toggleHighlight)
              useStore.getState().setView('plan')
            }}
          >
            Use as plan scope
          </MenuItem>
          <MenuItem
            disabled={busy || stopping}
            onClick={() => {
              void stopGroup(group.id, true).then((stopped) => {
                if (stopped) removeGroup(group.id)
              })
            }}
          >
            Delete
          </MenuItem>
        </Menu>
      </div>
      <div className="scope-chips">
        {nodes
          .filter((n) => group.componentIds.includes(n.id))
          .map((n) => (
            <span className="chip" key={n.id}>
              {n.data.name}
              <DevelopmentStatus node={n} />
            </span>
          ))}
      </div>
      <details
        className="component-group"
        open={editing}
        onToggle={(e) => setEditing(e.currentTarget.open)}
      >
        <summary>
          Edit stack <span className="count">{group.componentIds.length}</span>
        </summary>
        <fieldset disabled={blocked}>
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
              // The status chips sit beside the label, so clicking one doesn't toggle membership.
              <div key={node.id} className="group-member">
                <label className="group-option">
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
                </label>
                {group.componentIds.includes(node.id) && <DevelopmentStatus node={node} />}
              </div>
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
          <p className="hint">
            Terminal edits are shared with the Inspector and every stack using the component.
            Removing a terminal from startup keeps its saved definition. Stop and start running
            terminals to use changed commands or readiness settings.
          </p>
          <p className="hint">
            Chain preparation, builds and app launch with &amp;&amp; so failures prevent launch.
          </p>
          {nodes
            .filter((n) => group.componentIds.includes(n.id))
            .map((n) => (
              <StackTerminals key={n.id} node={n} />
            ))}
        </fieldset>
      </details>
      <div className="row">
        <button
          className="primary"
          title="Start stack in the selected worktree"
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
      </div>
    </section>
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
          <p className="hint" role="status">
            {done}
          </p>
        )}
        {restore && <div className="row">{restore}</div>}
      </div>
    ) : null
  return (
    <div className="task-action-result stack-suggestions">
      <strong title="Dev servers and watchers. Ready when is the output text that allows dependent services to start.">
        {creates ? 'Set up a stack' : 'More dev servers'}
      </strong>
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
export function StackReview({ pending, projectId }: { pending: PendingStack; projectId: string }) {
  const nodes = useStore((s) => s.nodes)
  const busy = useStackProposals((s) => !!s.busy[projectId])
  const blocked = useStore((s) => mapEditsBlocked(s.projects[projectId]))
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set())
  const [includeSetup, setIncludeSetup] = useState(true)
  const chosen = pending.terminals.filter((t) => !unticked.has(proposedKey(t)))
  const target = useStore((s) => s.groups.find((g) => g.id === pending.stackId))
  const members = [...new Set(chosen.map((t) => t.component))]
  const removals = target
    ? nodes.flatMap((n) => {
        if (!target.componentIds.includes(n.id) && !members.includes(n.id)) return []
        return n.data.terminals
          .filter(
            (t) =>
              t.kind === 'task' &&
              t.action === 'development' &&
              !chosen.some(
                (p) => p.component === n.id && proposedTerminal(p, n.data.terminals)?.id === t.id,
              ),
          )
          .map((t) => `${n.data.name} › ${t.name}`)
      })
    : []
  const name = (id: string) => nodes.find((n) => n.id === id)?.data.name ?? id
  return (
    <div className="task-action-result stack-suggestions" aria-label="Proposed stack">
      <strong>Proposed stack · {pending.name}</strong>
      <p className="hint">
        {target ? `Replaces “${target.name}” (${target.id}).` : 'Configures Development startup.'}{' '}
        {pending.orderedStartup ? 'Starts dependencies first.' : 'Starts members together.'}{' '}
        Applying saves configuration. Start executes it in the selected worktree.
      </p>
      {pending.stackId && !target && (
        <p className="hint">The target stack was removed. Discard and detect again.</p>
      )}
      <p className="hint">
        Resulting components: {members.map((id) => name(id)).join(', ') || 'none'}.
      </p>
      {target && (
        <p className="hint">
          Removed components:{' '}
          {target.componentIds
            .filter((id) => !members.includes(id))
            .map(name)
            .join(', ') || 'none'}
          .
        </p>
      )}
      <p className="hint">
        Shared terminal edits affect other stacks using them. Stop and start running terminals to
        use changes.
      </p>
      {removals.length > 0 && (
        <p className="hint">
          Removed from Development startup (definitions kept): {removals.join(', ')}.
        </p>
      )}
      <div className="validator-suggestions">
        {pending.worktreeSetup && (
          <label className="validator-suggestion">
            <input
              type="checkbox"
              checked={includeSetup}
              onChange={(e) => setIncludeSetup(e.target.checked)}
            />
            <span className="validator-suggestion-details">
              <span>Worktree preparation (for new tasks)</span>
              <code>{pending.worktreeSetup.command}</code>
              <span className="hint">{pending.worktreeSetup.reason}</span>
              <span className="hint">
                Saves or replaces the preparation command. Enable the exact command locally to allow
                execution.
              </span>
            </span>
          </label>
        )}
        {pending.terminals.map((t) => {
          const key = proposedKey(t)
          const existing = proposedTerminal(
            t,
            nodes.find((n) => n.id === t.component)?.data.terminals ?? [],
          )
          const patch = proposedPatch(t, existing, !!pending.stackId)
          const ready = patch?.readyWhen ?? existing?.readyWhen
          const changed =
            existing &&
            patch &&
            Object.entries(patch).some(
              ([key, value]) => existing[key as keyof typeof existing] !== value,
            )
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
                  {name(t.component)} › {existing?.name ?? t.terminal ?? `${t.name} (new)`}
                </span>
                <span className="hint">
                  {unticked.has(key)
                    ? 'Excluded'
                    : !existing
                      ? 'Added'
                      : changed
                        ? 'Changed'
                        : 'Unchanged'}
                </span>
                <code>{t.command ?? existing?.command}</code>
                {existing && t.command != null && t.command !== existing.command && (
                  <span className="hint">Replaces: {existing.command}</span>
                )}
                {existing && ready !== (existing.readyWhen ?? '') && (
                  <span className="hint">
                    Previous readiness: {existing.readyWhen || 'no wait'}
                  </span>
                )}
                <span className="hint">
                  {ready ? `Ready when “${ready}”` : 'Starts without waiting'}
                </span>
                <span className="hint">{t.reason}</span>
              </span>
            </label>
          )
        })}
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={
            busy ||
            blocked ||
            (!!pending.stackId && !target) ||
            (!target && !chosen.length && !(includeSetup && pending.worktreeSetup))
          }
          title={blocked ? 'Resolve the map conflict or project recovery first' : undefined}
          onClick={() => void applyStackProposal(pending, chosen, projectId, includeSetup)}
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

/**
 * Detection with an agent, for stacks the rules above can't see. A pending proposal locks a new
 * run until it is applied or discarded, though a running agent can always be shown.
 */
function StackAgent({ projectId, pending }: { projectId: string; pending?: PendingStack }) {
  const devices = useStore((s) => s.devices)
  const groups = useStore((s) => s.groups)
  const roles = useStore((s) => s.agentRoles)
  const running = useStore((s) => !!s.sessions[stackAgentSession(projectId)]?.running)
  const blocked = useStore((s) => mapEditsBlocked(s.projects[projectId]))
  const presets = planTerminals(devices)
  const [choice, setChoice] = useState<string>()
  const [target, setTarget] = useState('')
  // Clear a deleted target so restoring or recreating it doesn't silently select it again.
  const stackId = groups.find((g) => g.id === target)?.id
  if (target && !stackId) setTarget('')
  const preset =
    presets.find((t) => t.id === choice) ?? roleTerminal(devices, roles, 'plan') ?? presets[0]
  const locked = !running && !!pending
  return (
    <>
      <div className="stack-agent">
        <label>
          Target
          <select
            aria-label="Stack detection target"
            value={stackId ?? ''}
            disabled={running || !!pending || blocked}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">New stack</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Agent
          <select
            aria-label="Stack detection agent"
            value={preset?.id ?? ''}
            disabled={running || !!pending || blocked || !presets.length}
            onChange={(e) => setChoice(e.target.value)}
          >
            {!presets.length && <option value="">No agents available</option>}
            {presets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!running && (!preset || locked || blocked)}
          title={
            running
              ? 'Show the running stack detection agent'
              : locked
                ? 'Locked until the proposed stack is applied or discarded'
                : blocked
                  ? 'Resolve the map conflict or project recovery first'
                  : 'An agent reads the project and proposes worktree preparation and services for you to review'
          }
          onClick={() => {
            if (running)
              revealTerminal({ sid: stackAgentSession(projectId), componentId: MAP_SCOPE })
            else if (preset) void startStackAgent(projectId, preset, stackId)
          }}
        >
          {running ? 'Show stack detection' : 'Detect stack'}
        </button>
      </div>
      {locked && <p className="hint">Apply or discard the proposed stack to detect again.</p>}
    </>
  )
}

/** "＋ New stack" and its name form; a new stack starts with the selected components. */
function NewStackForm() {
  const blocked = useStore((s) => !!s.project && mapEditsBlocked(s.projects[s.project.id]))
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  return (
    <>
      <button disabled={blocked} onClick={() => setCreating(!creating)} aria-expanded={creating}>
        ＋ New stack
      </button>
      {creating && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim() || blocked) return
            const s = useStore.getState()
            const selected = s.nodes.filter((n) => n.selected || n.id === s.selectedId)
            s.addGroup(
              name.trim(),
              selected.map((n) => n.id),
            )
            setName('')
            setCreating(false)
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
      )}
      {creating && (
        <p className="hint">
          Choose components and configure their terminals in Edit stack after adding it.
        </p>
      )}
    </>
  )
}

/**
 * Stacks (`Project.groups`): sets of components whose Development terminals start together,
 * dependencies first when ordered, each waiting until it is ready.
 */
export default function StackPanel() {
  const task = useStore((s) => s.activeTask)
  const projectId = useStore((s) => s.project?.id)
  const pending = useStackProposals((s) => (projectId ? s.pending[projectId] : undefined))
  const groups = useStore((s) => s.groups)
  const report = useStore((s) => s.graphActionReport)
  return (
    <section className="component-groups" aria-label="Stacks">
      {!groups.length && (
        <p className="panel-empty panel-empty-start">
          Start related Development terminals together. Create a stack or discover one in Stack
          Detection.
        </p>
      )}
      <PanelSection title="Stacks" actions={<NewStackForm />}>
        {groups.map((group) => (
          <GroupEditor key={group.id} group={group} />
        ))}
      </PanelSection>
      <WorktreeSetupStatus key={task ?? 'main'} />
      <PanelDetails title="Stack Detection" reveal={!!pending}>
        {projectId && <StackAgent key={projectId} projectId={projectId} pending={pending} />}
        {projectId && pending && (
          <StackReview key={pending.id} pending={pending} projectId={projectId} />
        )}
        <StackSuggestions />
      </PanelDetails>
      <PanelDetails title="Worktree preparation">
        <WorktreeSetupPanel />
      </PanelDetails>
      {report && <StackActionResult />}
    </section>
  )
}

/** Always show the latest outcome; only offer details when there is something to inspect. */
function StackActionResult() {
  const report = useStore((s) => s.graphActionReport)
  const nodes = useStore((s) => s.nodes)
  if (!report) return null
  const unsuccessful = report.results.filter((result) => !taskPassed(result))
  const skipped = report.plan.skipped.length
  return (
    <div className="stack-action-result">
      <p className="hint" role="status">
        Last action ·{' '}
        {report.results.length
          ? `${report.results.filter(taskPassed).length}/${report.results.length} tasks passed`
          : 'No tasks ran'}
        {unsuccessful.length > 0 && ` · ${unsuccessful.length} unsuccessful`}
        {skipped > 0 && ` · ${skipped} skipped`}
      </p>
      {(unsuccessful.length > 0 || skipped > 0) && (
        <details className="action-results">
          <summary>View details</summary>
          {unsuccessful.map((result) => (
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
            <p className="hint" key={id}>
              {nodes.find((n) => n.id === id)?.data.name ?? id}: no configured tasks
            </p>
          ))}
        </details>
      )}
    </div>
  )
}

/** "Component › Terminal" for a session id, which is opaque. */
function resultLabel(sid: string) {
  const { componentId, terminalId } = parseSessionId(sid)
  const node = useStore.getState().nodes.find((n) => n.id === componentId)
  const terminal = node?.data.terminals.find((t) => t.id === terminalId)
  return `${node?.data.name ?? componentId} › ${terminal?.name ?? terminalId}`
}
