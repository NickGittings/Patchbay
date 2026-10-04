import { useState } from 'react'
import { useStore } from '../store'
import { runGraphAction, stopGroup } from '../lib/actions'
import type { ComponentGroup } from '../types'

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
      {group.orderedStartup && (
        <label>
          Readiness timeout (seconds)
          <input
            type="number"
            min={1}
            max={3600}
            value={group.readinessTimeoutSeconds}
            onChange={(e) =>
              updateGroup(group.id, {
                readinessTimeoutSeconds: Math.max(1, Math.min(3600, Number(e.target.value) || 30)),
              })
            }
          />
        </label>
      )}
      <div className="row">
        <button
          disabled={busy || stopping || !group.componentIds.length}
          onClick={() => void runGraphAction({ kind: 'startGroup', groupId: group.id })}
        >
          Start
        </button>
        <button
          disabled={stopping}
          title="Stop tasks started by this group; shared tasks keep running"
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
            if (await stopGroup(group.id)) removeGroup(group.id)
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
        Assign task roles in the component inspector. Save to keep groups.
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
              onClick={() => {
                const componentId = result.sessionId.slice(0, result.sessionId.lastIndexOf('/'))
                useStore.getState().select(componentId)
                useStore.getState().setActiveSession(result.sessionId)
                useStore.getState().setView('navigation')
              }}
            >
              <span>{result.sessionId}</span>
              <strong className={result.outcome === 'failed' ? 'failed' : ''}>
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
