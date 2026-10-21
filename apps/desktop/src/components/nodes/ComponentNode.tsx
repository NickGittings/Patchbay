import ExtensionBadges from '../../extensions/Badges'
import { ComponentMenuItems, ContextMenu } from '../ComponentActions'
import ChangesPopover from '../changes/ChangesPopover'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo, useState, type CSSProperties } from 'react'
import { nearbyIds } from '../../lib/plan'
import { useShallow } from 'zustand/react/shallow'
import { componentTerminals, mostUrgent } from '../../lib/attention'
import { useClockTick } from '../../lib/clock'
import { KIND_COLOR, statusTitle, terminalStatus } from '../../lib/display'
import { useStore, type FlowNode } from '../../store'
import { openComponentWindow } from '../../lib/windows'
import { sessionId } from '../../types'
import AttentionPill from '../status/AttentionPill'

function ComponentNode({ id, data, selected }: NodeProps<FlowNode>) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const planning = useStore((s) => s.view === 'plan')
  const highlighted = useStore((s) => s.highlighted.includes(id))
  const nearby = useStore((s) => s.view === 'plan' && nearbyIds(s.highlighted, s.edges).has(id))
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
  const repo = useStore((s) => s.repos[id])
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
      className={`component-node ${!planning && selected ? 'selected' : ''} ${planClass} ${
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

export default memo(ComponentNode)
