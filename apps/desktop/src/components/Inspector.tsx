import { openInEditor, revealLabel } from '../lib/navigation'
import { closeInspector } from '../lib/panels'
import { revealPath } from '../lib/ipc'
import ExtensionMenu from '../extensions/ExtensionMenu'
import { ExtensionView } from '../extensions/views'
import { useExtensionViews } from '../extensions/useExtensionViews'
import { absolutePath, openComponentWindow } from '../lib/windows'
import { activeWorktree } from '../lib/tasks'
import Menu, { MenuItem } from './Menu'
import PanelSection, { PanelDetails } from './PanelSection'
import { useId, useState } from 'react'
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
  type TerminalSpec,
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
          aria-label="Folder"
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
                useStore.getState().setMessage(String(e), undefined, undefined, 'error')
            }
          }}
        >
          Browse…
        </button>
      </div>
    </label>
  )
}

/** One action list serves both the header button and its context-menu entry point. */
function InspectorActions({ node, at }: { node: FlowNode; at?: { x: number; y: number } }) {
  const graphActionBusy = useStore((s) => s.graphActionBusy)
  const validating = useStore((s) =>
    ['validateAffected', 'validateChanged'].includes(s.graphAction?.kind ?? ''),
  )
  return (
    <Menu
      label="⋯"
      title="Component actions"
      triggerLabel="Component actions"
      triggerClassName="inspector-actions-trigger"
      caret={false}
      portal
      align="right"
      contextRequest={at}
    >
      <MenuItem
        onClick={() =>
          void revealPath(node.data.path).catch((e) =>
            useStore.getState().setMessage(String(e), undefined, undefined, 'error'),
          )
        }
      >
        {revealLabel}
      </MenuItem>
      <MenuItem onClick={() => void openComponentWindow(node.id, node.data.name)}>
        Open in window
      </MenuItem>
      {validating ? (
        <MenuItem
          title="Stop the running validator and skip the rest; results so far are kept"
          onClick={() => void stopValidation()}
        >
          Stop validation
        </MenuItem>
      ) : (
        <MenuItem
          disabled={graphActionBusy}
          title="Run validation task terminals for this component and all transitive consumers"
          onClick={() => void runGraphAction({ kind: 'validateAffected', componentId: node.id })}
        >
          Validate affected
        </MenuItem>
      )}
      <ExtensionMenu slot="component/actions" componentId={node.id} asMenuItems />
    </Menu>
  )
}

function InspectorHeader({ node, title }: { node?: FlowNode; title: string }) {
  const [at, setAt] = useState<{ x: number; y: number }>()
  const root = useStore((s) => activeWorktree(s) ?? s.project?.root)
  const path = node && root ? absolutePath(root, node.data.path) : node?.data.path
  return (
    <header
      className="inspector-header"
      onContextMenu={(e) => {
        if (!node || (e.target as Element).closest('button')) return
        e.preventDefault()
        setAt({ x: e.clientX, y: e.clientY })
      }}
    >
      <div className="inspector-title">
        {node && (
          <span
            className="kind-dot"
            style={{ background: KIND_COLOR[node.data.kind] }}
            title={node.data.kind}
            role="img"
            aria-label={node.data.kind}
          />
        )}
        <h2 title={title}>{title}</h2>
        {node && <InspectorActions node={node} at={at} />}
        <button
          className="inspector-close"
          title="Close the Inspector"
          aria-label="Close the Inspector"
          onClick={closeInspector}
        >
          ×
        </button>
      </div>
      {node && (
        <div className="inspector-path" title={path}>
          {node.data.path === '.' ? 'Repository root' : node.data.path}
        </div>
      )}
    </header>
  )
}

function InspectorTerminal({
  componentId,
  terminal: t,
}: {
  componentId: string
  terminal: TerminalSpec
}) {
  const [expanded, setExpanded] = useState(false)
  const settingsId = useId()
  const task = useStore((s) => s.activeTask)
  const sid = sessionId(componentId, t.id, task)
  const session = useStore((s) => s.sessions[sid])
  const status = terminalStatus(t.kind, session)
  const { updateTerminal, removeTerminal, setActiveSession } = useStore.getState()
  const update = (patch: Partial<TerminalSpec>) => updateTerminal(componentId, t.id, patch)
  return (
    <div className={`inspector-terminal health-${status.health}`}>
      <div className="inspector-terminal-row">
        <button
          className="inspector-terminal-disclosure"
          aria-label={`Settings for ${t.name}, ${t.kind}, ${statusTitle(status)}`}
          aria-expanded={expanded}
          aria-controls={settingsId}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="inspector-chevron" aria-hidden>
            ›
          </span>
          <span className="status-dot" aria-hidden />
          <span className="inspector-terminal-info">
            <span className="inspector-terminal-name" title={t.name}>
              {t.name}
            </span>
            <span className="inspector-terminal-meta">
              <span title={statusTitle(status)}>{status.label}</span>
              <span>
                {' '}
                · {t.kind}
                {t.action ? ` · ${t.action}` : ''}
              </span>
            </span>
          </span>
        </button>
        <button
          className="inspector-terminal-action"
          aria-label={`${session?.running ? 'Stop' : 'Start'} ${t.name}`}
          onClick={() => {
            if (session?.running) stopTerminal(sid)
            else {
              setActiveSession(sid)
              void startTerminal(componentId, t.id, task)
            }
          }}
        >
          {session?.running ? 'Stop' : 'Start'}
        </button>
      </div>
      <div id={settingsId} className="inspector-terminal-settings" hidden={!expanded}>
        <label>
          Name
          <input value={t.name} onChange={(e) => update({ name: e.target.value })} />
        </label>
        <label>
          Kind
          <select
            value={t.kind}
            onChange={(e) =>
              update({
                kind: e.target.value as TerminalKind,
                action: e.target.value === 'task' ? t.action : undefined,
              })
            }
          >
            {TERMINAL_KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label>
          Command
          <input
            className="mono"
            spellCheck={false}
            placeholder={describeTerminal(t) || 'command'}
            value={t.command}
            onChange={(e) => update({ command: e.target.value })}
          />
        </label>
        {t.kind === 'agent' && (
          <label>
            Conversation adapter
            <select
              value={t.adapter ?? ''}
              onChange={(e) =>
                update({
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
          <>
            <label>
              Graph action
              <select
                value={t.action ?? ''}
                onChange={(e) =>
                  update({ action: (e.target.value || undefined) as TerminalAction | undefined })
                }
              >
                <option value="">Manual only</option>
                <option value="development">Development (starts with its stack)</option>
                <option value="validation">Validation</option>
              </select>
            </label>
            <label>
              Ready when output contains
              <input
                className="mono"
                spellCheck={false}
                placeholder="Text that means this service is ready…"
                value={t.readyWhen ?? ''}
                onChange={(e) => update({ readyWhen: e.target.value || undefined })}
              />
            </label>
          </>
        )}
        <button
          aria-label={`Remove ${t.name}`}
          title={session?.running ? 'Stop this terminal before removing it' : 'Remove terminal'}
          disabled={session?.running}
          onClick={() => removeTerminal(componentId, t.id)}
        >
          Remove terminal
        </button>
      </div>
    </div>
  )
}

function ComponentInspector({ node }: { node: FlowNode }) {
  const { id, data } = node
  const projectId = useStore((s) => s.project?.id)
  const issues = useMaintenance((s) => s.issues[projectId ?? ''])
  useClockTick()
  const edges = useStore((s) => s.edges)
  const nodes = useStore((s) => s.nodes)
  const { updateComponent } = useStore.getState()
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
      {issues
        ?.filter((issue) => issue.componentId === id)
        .map((issue, i) => (
          <p className="map-issue" key={i}>
            <strong>{issue.kind}</strong>: {issue.message}
          </p>
        ))}
      <PanelSection title="Terminals">
        {data.terminals.length === 0 && (
          <p className="hint">No terminals yet. Add a preset or custom command.</p>
        )}
        {data.terminals.map((terminal) => (
          <InspectorTerminal key={terminal.id} componentId={id} terminal={terminal} />
        ))}
        <AddTerminalSelect componentId={id} />
      </PanelSection>
      <PanelDetails title="Component settings">
        <label>
          Name
          <input
            value={data.name}
            onChange={(e) => updateComponent(id, { name: e.target.value })}
          />
        </label>
        <label>
          Kind
          <select
            value={data.kind}
            onChange={(e) => updateComponent(id, { kind: e.target.value as ComponentKind })}
          >
            {COMPONENT_KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
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
      </PanelDetails>
      {dependsOn.length + usedBy.length > 0 && (
        <PanelSection title="Related">
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
        </PanelSection>
      )}
      <PanelDetails title="Details">
        <div className="maintenance-origin">
          Origin: {provenanceLabel(data.detection?.detector)}
          {data.detection?.packageIdentity && <span> · {data.detection.packageIdentity}</span>}
          {data.detection?.detector !== 'manual' && (
            <button onClick={() => updateComponent(id, { detection: { detector: 'manual' } })}>
              Mark manual
            </button>
          )}
        </div>
        <details
          className="context"
          onToggle={(e) => (e.currentTarget.open ? void loadContext() : undefined)}
        >
          <summary>Agent context</summary>
          <pre>{context ?? 'Loading…'}</pre>
        </details>
      </PanelDetails>
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
      <PanelSection title="Relationship">
        <p className="relation">
          <strong>{nameOf(edge.source)}</strong> depends on <strong>{nameOf(edge.target)}</strong>
        </p>
      </PanelSection>
      <PanelSection title="Link settings">
        <label>
          Label
          <input
            placeholder="e.g. REST, reads from, publishes to"
            value={edge.data?.label ?? ''}
            onChange={(e) => setEdgeLabel(edge.id, e.target.value)}
          />
        </label>
      </PanelSection>
      <PanelDetails title="Details">
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
      </PanelDetails>
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
  return (
    <PanelSection title={hasProject ? 'Project overview' : 'Get started'}>
      <p className="hint">
        {hasProject
          ? `${plural(components, 'component')} · ${plural(links, 'link')} · ${plural(changed, 'changed file')}`
          : 'Open a project folder to begin.'}
      </p>
      {hasProject && (
        <p className="hint">Select a component to run terminals and inspect its status.</p>
      )}
    </PanelSection>
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
      <InspectorHeader
        key={scope}
        node={node}
        title={node ? node.data.name : edgeId ? 'Link' : 'Inspector'}
      />
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
      {node && (
        <div className="inspector-toolbar">
          <button onClick={() => void openInEditor({ path: node.data.path })}>
            Open in editor
          </button>
        </div>
      )}
      <div className="inspector-body" key={`${scope}:${edgeId}`}>
        {showFiles && node ? (
          <FileTree key={scope} path={node.data.path} componentId={node.id} />
        ) : extensionViews.selected ? (
          <ExtensionView id={extensionViews.selected} />
        ) : node ? (
          <ComponentInspector key={`${project?.id}:${node.id}`} node={node} />
        ) : edgeId ? (
          <LinkInspector key={edgeId} edgeId={edgeId} />
        ) : (
          <NothingSelected hasProject={!!project} />
        )}
      </div>
    </div>
  )
}
