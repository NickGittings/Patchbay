import { createPortal } from 'react-dom'
import ExtensionBadges from '../../extensions/Badges'
import ExtensionMenu from '../../extensions/ExtensionMenu'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo, useState, type CSSProperties } from 'react'
import { nearbyIds } from '../../lib/plan'
import { KIND_COLOR, terminalHealth } from '../../lib/display'
import { useStore, type FlowNode } from '../../store'
import { openComponentWindow } from '../../lib/windows'
import { sessionId } from '../../types'

function ComponentNode({ id, data, selected }: NodeProps<FlowNode>) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const planning = useStore((s) => s.view === 'plan')
  const highlighted = useStore((s) => s.highlighted.includes(id))
  const nearby = useStore((s) => s.view === 'plan' && nearbyIds(s.highlighted, s.edges).has(id))
  const hasHighlights = useStore((s) => s.highlighted.length > 0)
  const planClass =
    planning && hasHighlights ? (highlighted ? 'highlighted' : nearby ? 'nearby' : 'dimmed') : ''
  const sessions = useStore((s) => s.sessions)
  const changes = useStore((s) => s.gitChanges[id] ?? 0)
  const repo = useStore((s) => s.repos[id])
  const activeSession = useStore((s) => s.activeSession)
  const color = KIND_COLOR[data.kind]

  const openTerminal = (terminalId: string) => {
    const s = useStore.getState()
    s.select(id)
    s.setActiveSession(sessionId(id, terminalId))
  }

  return (
    <div
      className={`component-node ${!planning && selected ? 'selected' : ''} ${planClass}`}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        useStore.getState().select(id)
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      style={{ '--kind': color } as CSSProperties}
    >
      {menu &&
        createPortal(
          <div
            className="node-menu-overlay nodrag"
            onClick={(e) => {
              e.stopPropagation()
              setMenu(null)
            }}
          >
            <div className="node-extension-menu" style={{ left: menu.x, top: menu.y }}>
              <ExtensionMenu slot="component/actions" componentId={id} />
              <button onClick={() => void openComponentWindow(id, data.name)}>
                Open in window
              </button>
            </div>
          </div>,
          document.body,
        )}
      <Handle type="target" position={Position.Left} className="link-handle" />
      <div className="component-header">
        <span className="kind-badge">{data.kind}</span>
        <span className="component-name">{data.name}</span>
        {repo && (
          <span className="repo-badge" title={`In the ${repo} repo`}>
            {repo}
          </span>
        )}
        {changes > 0 && (
          <span className="git-badge" title={`${changes} uncommitted change(s)`}>
            ±{changes}
          </span>
        )}
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
      <div className="component-path">{data.path === '.' ? '(repo root)' : data.path}</div>
      <div className="terminal-chips">
        {data.terminals.map((t) => {
          const sid = sessionId(id, t.id)
          return (
            <button
              key={t.id}
              className={`chip health-${terminalHealth(sessions[sid])} ${
                activeSession === sid ? 'active' : ''
              } nodrag`}
              onClick={(e) => {
                // Never toggle the node's highlight or switch the Navigation dock while planning.
                e.stopPropagation()
                if (!planning) openTerminal(t.id)
              }}
              aria-disabled={planning}
              tabIndex={planning ? -1 : undefined}
              title={t.command || 'interactive shell'}
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
