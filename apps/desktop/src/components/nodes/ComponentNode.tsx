import { rolesOf, useMapActivity } from '../../lib/mapActivity'
import type { AgentRole, RoleActivity } from '../../lib/activity'
import { revealTerminal } from '../../lib/attention'
import ExtensionBadges from '../../extensions/Badges'
import { ComponentMenuItems, ContextMenu } from '../ComponentActions'
import ChangesPopover from '../changes/ChangesPopover'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo, useState, type CSSProperties } from 'react'
import { affectedIds, nearbyIds } from '../../lib/plan'
import { useShallow } from 'zustand/react/shallow'
import { componentTerminals } from '../../lib/attention'
import { useClockTick } from '../../lib/clock'
import { KIND_COLOR, mostUrgent, statusTitle, terminalStatus } from '../../lib/display'
import { useStore, type FlowNode } from '../../store'
import { openComponentWindow } from '../../lib/windows'
import { useMaintenance } from '../../lib/maintenance'
import { sessionId } from '../../types'
import AttentionPill from '../status/AttentionPill'

function ComponentNode({ id, data, selected }: NodeProps<FlowNode>) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const simple = useStore((s) => s.simpleMode)
  const pulsing = useMapActivity((s) => s.active.includes(id))
  const roles = useMapActivity(rolesOf(id))
  const planning = useStore((s) => s.simpleMode || s.view === 'plan')
  const highlighted = useStore((s) => s.highlighted.includes(id))
  const nearby = useStore(
    (s) => (s.simpleMode || s.view === 'plan') && nearbyIds(s.highlighted, s.edges).has(id),
  )
  const hasHighlights = useStore((s) => s.highlighted.length > 0)
  const proposed = useStore((s) => s.view === 'plan' && s.proposedScope.includes(id))
  const planClass = !planning
    ? ''
    : highlighted
      ? 'highlighted'
      : proposed
        ? 'proposed'
        : hasHighlights
          ? nearby
            ? 'nearby'
            : 'dimmed'
          : ''
  const task = useStore((s) => s.activeTask)
  const inTask = useStore(
    (s) => !!s.activeTask && !!s.tasks.find((t) => t.id === s.activeTask)?.components.includes(id),
  )
  // Only this node's sessions (with those its extensions started), so other terminals' status
  // updates don't re-render it.
  // Flat lists of strings and existing objects, which compare equal when nothing changed.
  const kinds = useStore(
    useShallow((s) =>
      componentTerminals(id, data.terminals, s.runtimeTerminals, s.activeTask).map(
        ([, t]) => t.kind,
      ),
    ),
  )
  const sessions = useStore(
    useShallow((s) =>
      componentTerminals(id, data.terminals, s.runtimeTerminals, s.activeTask).map(
        ([sid]) => s.sessions[sid],
      ),
    ),
  )
  useClockTick()
  // Its own terminals come first, so `statuses[i]` matches `data.terminals[i]`.
  const statuses = kinds.map((kind, i) => terminalStatus(kind, sessions[i]))
  const changes = useStore((s) => s.gitChanges[id] ?? 0)
  const affected = useStore((s) => !planning && affectedIds(s.gitChanges, s.edges).has(id))
  const repo = useStore((s) => s.repos[id])
  const projectId = useStore((s) => s.project?.id ?? '')
  const issues = useMaintenance(
    useShallow((s) => (s.issues[projectId] ?? []).filter((i) => i.componentId === id)),
  )
  const activeSession = useStore((s) => s.activeSession)
  const color = KIND_COLOR[data.kind]
  const attention = mostUrgent(statuses)

  const openTerminal = (terminalId: string) => {
    const s = useStore.getState()
    s.select(id)
    s.setActiveSession(sessionId(id, terminalId, s.activeTask))
  }

  return (
    <div
      className={`component-node ${simple && changes > 0 ? 'simple-changed' : ''} ${pulsing ? 'activity-pulse' : ''} ${affected ? 'affected' : ''} ${!planning && selected ? 'selected' : ''} ${planClass} ${
        inTask ? 'in-task' : ''
      }`}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        useStore.getState().select(id)
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      style={{ '--kind': color } as CSSProperties}
    >
      {menu && (
        <ContextMenu at={menu} onClose={() => setMenu(null)}>
          <ComponentMenuItems
            id={id}
            name={data.name}
            path={data.path}
            terminals={data.terminals}
            onDone={() => setMenu(null)}
          />
        </ContextMenu>
      )}
      <Handle type="target" position={Position.Left} className="link-handle" />
      <div className="component-header">
        <span
          className="component-name"
          title={`${data.kind} · ${data.path === '.' ? 'repo root' : data.path}`}
        >
          {data.name}
        </span>
        {inTask && (
          <span className="task-badge" title="In the active task">
            Task
          </span>
        )}
        {repo && (
          <span className="repo-badge" title={`In the ${repo} repo`}>
            {repo}
          </span>
        )}
        {issues.map((issue) => (
          <span className="count map-issue" key={issue.kind} title={issue.message}>
            {issue.kind}
          </span>
        ))}
        {changes > 0 && <ChangesPopover componentId={id} />}
        <AttentionPill status={attention} />
        <ExtensionBadges componentId={id} />
        <button
          className="nodrag popout-button"
          title="Open component in window"
          aria-label={`Open ${data.name} in window`}
          onClick={(e) => {
            e.stopPropagation()
            void openComponentWindow(id, data.name)
          }}
        >
          ⧉
        </button>
      </div>
      {roles.length > 0 && <AgentRoles roles={roles} />}
      <div className="terminal-chips">
        {data.terminals.map((t, i) => {
          const sid = sessionId(id, t.id, task)
          const status = statuses[i]
          return (
            <button
              key={t.id}
              className={`chip health-${status.health} ${
                activeSession === sid ? 'active' : ''
              } nodrag`}
              onClick={(e) => {
                // Never toggle the node's highlight or switch the Navigation dock while planning.
                e.stopPropagation()
                if (!planning) openTerminal(t.id)
              }}
              aria-disabled={planning}
              tabIndex={planning ? -1 : undefined}
              title={statusTitle(status, t.command || 'interactive shell')}
            >
              <span className="status-dot" />
              {t.name}
            </button>
          )
        })}
      </div>
      <Handle type="source" position={Position.Right} className="link-handle" />
    </div>
  )
}

const ROLE_LABEL: Record<AgentRole, string> = {
  plan: 'Plan',
  build: 'Build',
  fix: 'Fix',
  review: 'Review',
  merge: 'Merge',
}

/** One chip per role agent that worked on this component's files; opens its newest session. */
function AgentRoles({ roles }: { roles: RoleActivity[] }) {
  const byRole = new Map<AgentRole, RoleActivity[]>()
  for (const entry of roles) byRole.set(entry.role, [...(byRole.get(entry.role) ?? []), entry])
  return (
    <div className="agent-roles">
      {[...byRole].map(([role, entries]) => {
        const live = entries.some((e) => e.live)
        const paths = [...new Set(entries.flatMap((e) => e.paths))]
        const shown = paths.slice(0, 8).join('\n')
        const more = paths.length > 8 ? `\n…and ${paths.length - 8} more` : ''
        return (
          <button
            key={role}
            className={`agent-role ${role} ${live ? 'live' : ''} nodrag`}
            title={`${ROLE_LABEL[role]} agent ${live ? 'is working here' : 'worked here'}:\n${shown}${more}`}
            onClick={(e) => {
              e.stopPropagation()
              revealTerminal({ sid: entries[0].sessionId, componentId: entries[0].scope })
            }}
          >
            <span className="status-dot" />
            {ROLE_LABEL[role]}
          </button>
        )
      })}
    </div>
  )
}

export default memo(ComponentNode)
