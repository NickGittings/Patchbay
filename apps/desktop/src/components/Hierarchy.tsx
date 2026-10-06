import ExtensionBadges from '../extensions/Badges'
import { useReactFlow } from '@xyflow/react'
import { openComponentWindow } from '../lib/windows'
import { componentAttention } from '../lib/attention'
import { useClockTick } from '../lib/clock'
import { KIND_COLOR } from '../lib/display'
import { useStore } from '../store'
import { sessionId } from '../types'
import AttentionPill from './status/AttentionPill'
import ComponentGroups from './ComponentGroups'
import { provenanceLabel, useMaintenance } from '../lib/maintenance'

/** Outline of every component, like a game engine's scene hierarchy. */
export default function Hierarchy() {
  const project = useStore((s) => s.project)
  const issues = useMaintenance((s) => s.issues[project?.id ?? ''])
  const nodes = useStore((s) => s.nodes)
  const sessions = useStore((s) => s.sessions)
  const runtimeTerminals = useStore((s) => s.runtimeTerminals)
  const task = useStore((s) => s.activeTask)
  const gitChanges = useStore((s) => s.gitChanges)
  const selectedId = useStore((s) => s.selectedId)
  const select = useStore((s) => s.select)
  const { setCenter } = useReactFlow()
  useClockTick()

  const focus = (id: string) => {
    select(id)
    const node = nodes.find((n) => n.id === id)
    if (node) {
      const w = node.measured?.width ?? 260
      const h = node.measured?.height ?? 120
      void setCenter(node.position.x + w / 2, node.position.y + h / 2, {
        zoom: 1,
        duration: 300,
      })
    }
  }

  const sorted = [...nodes].sort((a, b) => a.data.name.localeCompare(b.data.name))

  return (
    <div className="panel hierarchy">
      <div className="panel-title">Components</div>
      {sorted.map((n) => {
        const running = n.data.terminals.filter(
          (t) => sessions[sessionId(n.id, t.id, task)]?.running,
        ).length
        const changes = gitChanges[n.id] ?? 0
        const attention = componentAttention(
          n.id,
          n.data.terminals,
          sessions,
          runtimeTerminals,
          task,
        )
        return (
          <button
            key={n.id}
            className={`hierarchy-item ${n.id === selectedId ? 'active' : ''}`}
            onClick={() => focus(n.id)}
            onDoubleClick={() => void openComponentWindow(n.id, n.data.name)}
          >
            <span className="kind-dot" style={{ background: KIND_COLOR[n.data.kind] }} />
            <span
              className="hierarchy-name"
              title={`Origin: ${provenanceLabel(n.data.detection?.detector)}`}
            >
              {n.data.name}
            </span>
            {issues
              ?.filter((i) => i.componentId === n.id)
              .map((issue) => (
                <span className="count map-issue" key={issue.kind} title={issue.message}>
                  {issue.kind}
                </span>
              ))}
            <ExtensionBadges componentId={n.id} />
            <AttentionPill status={attention} />
            {running > 0 && (
              <span className="count running" title={`${running} running`}>
                {running}
              </span>
            )}
            {changes > 0 && (
              <span className="count" title={`${changes} uncommitted`}>
                ±{changes}
              </span>
            )}
          </button>
        )
      })}
      {nodes.length === 0 && (
        <div className="hint">{project ? 'No components.' : 'No project open.'}</div>
      )}
      {project && <ComponentGroups />}
    </div>
  )
}
