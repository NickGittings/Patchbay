import { useState } from 'react'
import { matchesComponent } from '../lib/hierarchy'
import { ComponentMenuItems, ContextMenu } from './ComponentActions'
import ChangesPopover from './changes/ChangesPopover'
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
import EmptyState from './EmptyState'
import { useAddFolder, useOpenProject, useRescanProject } from '../lib/project'

/** Outline of every component, like a game engine's scene hierarchy. */
export default function Hierarchy() {
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(-1)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
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
  const openFolder = useOpenProject()
  const rescan = useRescanProject()
  const addRepo = useAddFolder()
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
  const filtering = nodes.length > 5
  // A hidden filter forgets its query, so it doesn't come back applied when the box reappears.
  if (!filtering && query) setQuery('')
  const filtered = filtering ? sorted.filter((node) => matchesComponent(node, query)) : sorted
  // Clamped, so a row removed from the list (or the filter going away) never leaves it stale.
  const index = filtering ? Math.min(highlighted, filtered.length - 1) : -1
  const highlightedId = filtered[index]?.id
  const menuNode = nodes.find((node) => node.id === menu?.id)

  return (
    <div className="panel hierarchy">
      <div className="panel-title">Components</div>
      {filtering && (
        <input
          className="hierarchy-filter"
          aria-label="Filter components"
          aria-activedescendant={highlightedId ? `hierarchy-${highlightedId}` : undefined}
          placeholder="Filter components…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setHighlighted(-1)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const length = filtered.length
              setHighlighted(
                !length
                  ? -1
                  : e.key === 'ArrowDown'
                    ? (index + 1) % length
                    : index < 0
                      ? length - 1
                      : (index + length - 1) % length,
              )
            } else if (e.key === 'Enter') {
              e.preventDefault()
              // Without a highlighted row, Enter takes the first match.
              const target = highlightedId ?? (query.trim() ? filtered[0]?.id : undefined)
              if (target) focus(target)
            } else if (e.key === 'Escape') {
              e.stopPropagation()
              setQuery('')
              setHighlighted(-1)
            }
          }}
        />
      )}
      {menu && menuNode && (
        <ContextMenu at={menu} onClose={() => setMenu(null)}>
          <ComponentMenuItems
            id={menuNode.id}
            name={menuNode.data.name}
            path={menuNode.data.path}
            terminals={menuNode.data.terminals}
            onDone={() => setMenu(null)}
          />
        </ContextMenu>
      )}
      {filtered.map((n) => {
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
          <div
            key={n.id}
            className={`hierarchy-item ${n.id === selectedId ? 'active' : ''} ${n.id === highlightedId ? 'highlighted' : ''}`}
            onContextMenu={(e) => {
              e.preventDefault()
              select(n.id)
              setMenu({ id: n.id, x: e.clientX, y: e.clientY })
            }}
            onClick={() => focus(n.id)}
            onDoubleClick={() => void openComponentWindow(n.id, n.data.name)}
          >
            <button className="hierarchy-select" id={`hierarchy-${n.id}`}>
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
            </button>
            {changes > 0 && <ChangesPopover componentId={n.id} />}
          </div>
        )
      })}
      {nodes.length > 0 && filtered.length === 0 && <div className="hint">No matches</div>}
      {nodes.length === 0 &&
        (project ? (
          <EmptyState
            compact
            icon="◇"
            title="No components"
            actions={
              <>
                <button onClick={() => void rescan()}>Rescan</button>
                <button onClick={() => void addRepo()}>Add repo…</button>
              </>
            }
          >
            Rescan the project or add a repository to map its parts.
          </EmptyState>
        ) : (
          <EmptyState
            compact
            icon="◇"
            title="No project open"
            actions={<button onClick={() => void openFolder()}>Open project…</button>}
          >
            Components appear here once a project is open.
          </EmptyState>
        ))}
      {project && <ComponentGroups />}
    </div>
  )
}
