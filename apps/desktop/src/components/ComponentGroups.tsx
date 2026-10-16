import { useState } from 'react'
import { useStore } from '../store'
import { runGraphAction, stopGroup } from '../lib/actions'
import { parseSessionId, type ComponentGroup } from '../types'

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

function GroupEditor({ group }: { group: ComponentGroup }) {
  const nodes = useStore((s) => s.nodes)
  const busy = useStore((s) => s.graphActionBusy)
  const { updateGroup, removeGroup, toggleHighlight } = useStore.getState()
  const [stopping, setStopping] = useState(false)
  return (
    <details className="component-group">
      <summary>
        {group.name} <span className="count">{group.componentIds.length}</span>
      </summary>
      <label>
        Name
        <input
          aria-label="Group name"
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
          title="Stop tasks this group started in the current worktree; shared tasks keep running"
          onClick={async () => {
            setStopping(true)
            await stopGroup(group.id)
            setStopping(false)
          }}
        >
          Stop
        </button>
        <button
          title="Use this group as the planner scope"
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

export default function ComponentGroups() {
  const groups = useStore((s) => s.groups)
  const nodes = useStore((s) => s.nodes)
  const report = useStore((s) => s.graphActionReport)
  const [name, setName] = useState('')
  return (
    <section className="component-groups" aria-label="Component groups">
      <div className="section-title">Groups</div>
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
          aria-label="New group name"
          placeholder="New group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" disabled={!name.trim()}>
          Add
        </button>
      </form>
      <p className="hint flush">
        Assign task roles in the component inspector. Groups save automatically once the map
        configuration exists.
      </p>
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
                // Stay in Navigation, where these results and the dock live.
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
