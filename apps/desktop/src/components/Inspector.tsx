import { openInEditor, revealLabel } from '../lib/navigation'
import { closeInspector } from '../lib/panels'
import { revealPath } from '../lib/ipc'
import ExtensionMenu from '../extensions/ExtensionMenu'
import { ExtensionView } from '../extensions/views'
import { useExtensionViews } from '../extensions/useExtensionViews'
import { openComponentWindow } from '../lib/windows'
import { useState } from 'react'
import { describeTerminal, KIND_COLOR, plural, statusTitle, terminalStatus } from '../lib/display'
import { useClockTick } from '../lib/clock'
import { peersFor } from '../lib/plan'
import AddTerminalSelect from './AddTerminalSelect'
import FileTree from './FileTree'
import { componentContext, pickComponentFolder } from '../lib/ipc'
import { repairComponentPath, provenanceLabel, useMaintenance } from '../lib/maintenance'
import { startTerminal, stopTerminal } from '../lib/sessions'
import { runGraphAction, stopValidation } from '../lib/actions'
import { useStore, type FlowNode } from '../store'
import {
  COMPONENT_KINDS,
  sessionId,
  type ComponentKind,
  type TerminalKind,
  type TerminalAction,
} from '../types'

const TERMINAL_KINDS: TerminalKind[] = ['shell', 'task', 'agent']

function ComponentFolder({
  componentId,
  path,
  projectId,
}: {
  componentId: string
  path: string
  projectId?: string
}) {
  const [folder, setFolder] = useState(path)
  return (
    <label>
      Folder
      <div className="row">
        <input
          spellCheck={false}
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          onBlur={() => {
            if (folder !== path)
              void repairComponentPath(componentId, folder, projectId).then((accepted) => {
                if (!accepted) setFolder(path)
              })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <button
          onClick={async () => {
            try {
              const picked = await pickComponentFolder()
              if (picked) await repairComponentPath(componentId, picked, projectId)
            } catch (e) {
              if (useStore.getState().project?.id === projectId)
                useStore.getState().setMessage(String(e))
            }
          }}
        >
          Browse…
        </button>
      </div>
    </label>
  )
}

function ComponentInspector({ node }: { node: FlowNode }) {
  const { id, data } = node
  const projectId = useStore((s) => s.project?.id)
  const issue = useMaintenance((s) => s.issues[projectId ?? '']?.find((i) => i.componentId === id))
  const sessions = useStore((s) => s.sessions)
  const graphActionBusy = useStore((s) => s.graphActionBusy)
  const validating = useStore((s) =>
    ['validateAffected', 'validateChanged'].includes(s.graphAction?.kind ?? ''),
  )
  const task = useStore((s) => s.activeTask)
  useClockTick()
  const edges = useStore((s) => s.edges)
  const nodes = useStore((s) => s.nodes)
  const { updateComponent, updateTerminal, removeTerminal, setActiveSession } = useStore.getState()
  const [context, setContext] = useState<string | null>(null)

  const nameOf = (nid: string) => nodes.find((n) => n.id === nid)?.data.name ?? nid
  const dependsOn = edges.filter((e) => e.source === id)
  const usedBy = edges.filter((e) => e.target === id)

  const loadContext = async () => {
    try {
      const s = useStore.getState()
      setContext(
        await componentContext(
          s.toProject(),
          id,
          s.activeTask ?? undefined,
          peersFor(id, s.highlighted),
        ),
      )
    } catch (e) {
      setContext(String(e))
    }
  }

  return (
    <>
      <label>
        Name
        <input value={data.name} onChange={(e) => updateComponent(id, { name: e.target.value })} />
      </label>
      <button className="inspector-popout" onClick={() => void openComponentWindow(id, data.name)}>
        ⧉ Open in window
      </button>
      <div className="row">
        <button onClick={() => void openInEditor({ path: data.path })}>Open in editor</button>
        <button
          onClick={() =>
            void revealPath(data.path).catch((e) => useStore.getState().setMessage(String(e)))
          }
        >
          {revealLabel}
        </button>
        <ExtensionMenu slot="component/actions" componentId={id} />
        {validating ? (
          <button
            title="Stop the running validator and skip the rest; results so far are kept"
            onClick={() => void stopValidation()}
          >
            Stop validation
          </button>
        ) : (
          <button
            disabled={graphActionBusy}
            title="Run validation task terminals for this component and all transitive consumers"
            onClick={() => void runGraphAction({ kind: 'validateAffected', componentId: id })}
          >
            Validate affected
          </button>
        )}
      </div>
      <div className="row">
        <label className="grow">
          Kind
          <select
            value={data.kind}
            style={{ borderLeft: `3px solid ${KIND_COLOR[data.kind]}` }}
            onChange={(e) => updateComponent(id, { kind: e.target.value as ComponentKind })}
          >
            {COMPONENT_KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="maintenance-origin">
        Origin: {provenanceLabel(data.detection?.detector)}
        {data.detection?.packageIdentity && <span> · {data.detection.packageIdentity}</span>}
        {data.detection?.detector !== 'manual' && (
          <button onClick={() => updateComponent(id, { detection: { detector: 'manual' } })}>
            Mark manual
          </button>
        )}
      </div>
      {issue && (
        <p className="map-issue">
          <strong>{issue.kind}</strong>: {issue.message}
        </p>
      )}
      <ComponentFolder key={data.path} componentId={id} path={data.path} projectId={projectId} />
      <label>
        Notes
        <textarea
          rows={3}
          placeholder="What this component does, key files, gotchas… (shared with agents)"
          value={data.notes}
          onChange={(e) => updateComponent(id, { notes: e.target.value })}
        />
      </label>

      <div className="section-title">Terminals</div>
      {data.terminals.map((t) => {
        const sid = sessionId(id, t.id, task)
        const session = sessions[sid]
        const status = terminalStatus(t.kind, session)
        return (
          <div key={t.id} className={`terminal-row health-${status.health}`}>
            <div className="row">
              <span className="status-dot" title={statusTitle(status)} />
              <input
                className="grow"
                value={t.name}
                onChange={(e) => updateTerminal(id, t.id, { name: e.target.value })}
              />
              <select
                value={t.kind}
                onChange={(e) =>
                  updateTerminal(id, t.id, {
                    kind: e.target.value as TerminalKind,
                    action: e.target.value === 'task' ? t.action : undefined,
                  })
                }
              >
                {TERMINAL_KINDS.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
              {session?.running ? (
                <button title="Stop" onClick={() => stopTerminal(sid)}>
                  ■
                </button>
              ) : (
                <button
                  title="Start"
                  onClick={() => {
                    setActiveSession(sid)
                    void startTerminal(id, t.id, task)
                  }}
                >
                  ▶
                </button>
              )}
              <button
                title="Remove terminal"
                disabled={session?.running}
                onClick={() => removeTerminal(id, t.id)}
              >
                ✕
              </button>
            </div>
            <input
              className="mono"
              spellCheck={false}
              placeholder={describeTerminal(t) || 'command'}
              value={t.command}
              onChange={(e) => updateTerminal(id, t.id, { command: e.target.value })}
            />
            {t.kind === 'agent' && (
              <label>
                Conversation adapter
                <select
                  value={t.adapter ?? ''}
                  onChange={(e) =>
                    updateTerminal(id, t.id, {
                      adapter: (e.target.value || undefined) as 'claude' | 'codex' | undefined,
                    })
                  }
                >
                  <option value="">Auto (recognized commands)</option>
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
            )}
            {t.kind === 'task' && (
              <label>
                Graph action
                <select
                  value={t.action ?? ''}
                  onChange={(e) =>
                    updateTerminal(id, t.id, {
                      action: (e.target.value || undefined) as TerminalAction | undefined,
                    })
                  }
                >
                  <option value="">Manual only</option>
                  <option value="development">Development environment</option>
                  <option value="validation">Validation</option>
                </select>
              </label>
            )}
            {t.kind === 'task' && (
              <input
                className="mono"
                spellCheck={false}
                placeholder="Ready when output contains…"
                title="Output text that means this service is ready"
                value={t.readyWhen ?? ''}
                onChange={(e) =>
                  updateTerminal(id, t.id, { readyWhen: e.target.value || undefined })
                }
              />
            )}
          </div>
        )
      })}
      <AddTerminalSelect componentId={id} />

      <div className="section-title">Related</div>
      {dependsOn.length + usedBy.length === 0 && (
        <div className="hint flush">None. Drag from the node's right edge to add one.</div>
      )}
      {dependsOn.map((e) => (
        <div key={e.id} className="relation">
          depends on <strong>{nameOf(e.target)}</strong>
        </div>
      ))}
      {usedBy.map((e) => (
        <div key={e.id} className="relation">
          used by <strong>{nameOf(e.source)}</strong>
        </div>
      ))}

      <details
        className="context"
        onToggle={(e) => (e.currentTarget.open ? void loadContext() : undefined)}
      >
        <summary>Agent context</summary>
        <pre>{context ?? 'Loading…'}</pre>
      </details>
    </>
  )
}

function LinkInspector({ edgeId }: { edgeId: string }) {
  const edge = useStore((s) => s.edges.find((e) => e.id === edgeId))
  const nodes = useStore((s) => s.nodes)
  const { setEdgeLabel, onEdgesChange, selectEdge } = useStore.getState()
  if (!edge) return null
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.data.name ?? id

  return (
    <>
      <p className="relation">
        <strong>{nameOf(edge.source)}</strong> depends on <strong>{nameOf(edge.target)}</strong>
      </p>
      <label>
        Label
        <input
          placeholder="e.g. REST, reads from, publishes to"
          value={edge.data?.label ?? ''}
          onChange={(e) => setEdgeLabel(edge.id, e.target.value)}
        />
      </label>
      <p className="maintenance-origin">
        Origin: {provenanceLabel(edge.data?.detection?.detector)}
      </p>
      {edge.data?.detection?.detector !== 'manual' && (
        <button
          onClick={() =>
            useStore.setState((s) => ({
              edges: s.edges.map((e) =>
                e.id === edge.id
                  ? { ...e, data: { ...e.data, detection: { detector: 'manual' } } }
                  : e,
              ),
              dirty: true,
            }))
          }
        >
          Mark manual
        </button>
      )}
      <button
        className="danger"
        onClick={() => {
          onEdgesChange([{ type: 'remove', id: edge.id }])
          selectEdge(null)
        }}
      >
        Delete link
      </button>
    </>
  )
}

/** Project at a glance while nothing is selected. */
function NothingSelected({ hasProject }: { hasProject: boolean }) {
  const components = useStore((s) => s.nodes.length)
  const links = useStore((s) => s.edges.length)
  const changed = useStore((s) => Object.values(s.gitChanges).reduce((a, b) => a + b, 0))
  if (!hasProject) return <div className="hint flush">Open a project folder to begin.</div>
  return (
    <div className="hint flush">
      {plural(components, 'component')} · {plural(links, 'link')} ·{' '}
      {plural(changed, 'changed file')}
    </div>
  )
}

export default function Inspector() {
  const extensionViews = useExtensionViews('inspector')
  const node = useStore((s) => s.nodes.find((n) => n.id === s.selectedId))
  const edgeId = useStore((s) => s.selectedEdgeId)
  const project = useStore((s) => s.project)
  const scope = JSON.stringify([project?.id, node?.id])
  const [filesTab, setFilesTab] = useState({ scope, selected: false })
  if (filesTab.scope !== scope) setFilesTab({ scope, selected: false })
  const showFiles = filesTab.selected && !!node

  return (
    <div className="panel inspector">
      <div className="panel-title inspector-title">
        {node ? 'Component' : edgeId ? 'Link' : 'Inspector'}
        <button
          className="inspector-close"
          title="Close the Inspector"
          aria-label="Close the Inspector"
          onClick={closeInspector}
        >
          ×
        </button>
      </div>
      {(node || extensionViews.views.length > 0) && (
        <div className="tabs">
          <button
            className={!showFiles && !extensionViews.selected ? 'active' : ''}
            onClick={() => {
              setFilesTab({ scope, selected: false })
              extensionViews.setSelected(null)
            }}
          >
            Component
          </button>
          {node && (
            <button
              className={showFiles ? 'active' : ''}
              onClick={() => {
                setFilesTab({ scope, selected: true })
                extensionViews.setSelected(null)
              }}
            >
              Files
            </button>
          )}
          {extensionViews.views.map((view) => (
            <button
              key={view.id}
              data-extension-view-tab={view.id}
              className={extensionViews.selected === view.id ? 'active' : ''}
              onClick={() => {
                setFilesTab({ scope, selected: false })
                extensionViews.setSelected(view.id)
              }}
            >
              {view.title}
            </button>
          ))}
        </div>
      )}
      {showFiles && node ? (
        <FileTree
          key={scope}
          root={project?.root ?? node.data.path}
          path={node.data.path}
          componentId={node.id}
        />
      ) : extensionViews.selected ? (
        <ExtensionView id={extensionViews.selected} />
      ) : node ? (
        <ComponentInspector key={`${project?.id}:${node.id}`} node={node} />
      ) : edgeId ? (
        <LinkInspector edgeId={edgeId} />
      ) : (
        <NothingSelected hasProject={!!project} />
      )}
    </div>
  )
}
