import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo, type CSSProperties } from 'react'
import { KIND_COLOR, terminalHealth } from '../../lib/display'
import { useStore, type FlowNode } from '../../store'
import { openComponentWindow } from '../../lib/windows'
import { sessionId } from '../../types'

function ComponentNode({ id, data, selected }: NodeProps<FlowNode>) {
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
      className={`component-node ${selected ? 'selected' : ''}`}
      style={{ '--kind': color } as CSSProperties}
    >
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
                e.stopPropagation()
                openTerminal(t.id)
              }}
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
