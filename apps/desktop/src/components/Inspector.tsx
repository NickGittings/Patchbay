import ExtensionMenu from '../extensions/ExtensionMenu'
import { ExtensionView } from '../extensions/views'
import { useExtensionViews } from '../extensions/useExtensionViews'
import { openComponentWindow } from '../lib/windows'
import { useState } from 'react'
import { describeTerminal, KIND_COLOR, statusTitle, terminalStatus } from '../lib/display'
import { useClockTick } from '../lib/clock'
import { componentContext, pickComponentFolder } from '../lib/ipc'
import { syncCurrentRoots } from '../lib/access'
import { startTerminal, stopTerminal } from '../lib/sessions'
import { useStore, type FlowNode } from '../store'
import { COMPONENT_KINDS, sessionId, type ComponentKind, type TerminalKind } from '../types'

const TERMINAL_KINDS: TerminalKind[] = ['shell', 'task', 'agent']

function ComponentInspector({ node }: { node: FlowNode }) {
  const { id, data } = node
  const devices = useStore((s) => s.devices)
  const sessions = useStore((s) => s.sessions)
  useClockTick()
  const edges = useStore((s) => s.edges)
  const nodes = useStore((s) => s.nodes)
  const { updateComponent, updateTerminal, removeTerminal, addTerminal, setActiveSession } =
    useStore.getState()
  const [context, setContext] = useState<string | null>(null)

  const nameOf = (nid: string) => nodes.find((n) => n.id === nid)?.data.name ?? nid
  const dependsOn = edges.filter((e) => e.source === id)
  const usedBy = edges.filter((e) => e.target === id)

  const loadContext = async () => {
    try {
      setContext(await componentContext(useStore.getState().toProject(), id))
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
        <ExtensionMenu slot="component/actions" componentId={id} />
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
      <label>
        Folder
        <div className="row">
          <input
            spellCheck={false}
            value={data.path}
            onChange={(e) => updateComponent(id, { path: e.target.value })}
          />
          <button
            onClick={async () => {
              try {
                const path = await pickComponentFolder()
                if (path) {
                  updateComponent(id, { path })
                  await syncCurrentRoots()
                }
              } catch (e) {
                useStore.getState().setMessage(String(e))
              }
            }}
          >
            Browse
          </button>
        </div>
      </label>
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
        const sid = sessionId(id, t.id)
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
                onChange={(e) => updateTerminal(id, t.id, { kind: e.target.value as TerminalKind })}
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
                    void startTerminal(id, t.id)
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
              <input
                className="mono"
                spellCheck={false}
                placeholder="Ready when output contains… (a local URL also counts)"
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
      <select
        className="add-terminal"
        value=""
        onChange={(e) => {
          const v = e.target.value
          addTerminal(id, v === 'custom' ? null : (devices.find((d) => d.id === v) ?? null))
        }}
      >
        <option value="" disabled>
          + Add terminal…
        </option>
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} {d.command ? `— ${d.command}` : ''}
          </option>
        ))}
        <option value="custom">Custom command</option>
      </select>

      <div className="section-title">Related</div>
      {dependsOn.length + usedBy.length === 0 && (
        <div className="hint flush">
          Drag from this node's right edge to another component to say it depends on it.
        </div>
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

export default function Inspector() {
  const extensionViews = useExtensionViews('inspector')
  const node = useStore((s) => s.nodes.find((n) => n.id === s.selectedId))
  const edgeId = useStore((s) => s.selectedEdgeId)
  const project = useStore((s) => s.project)

  return (
    <div className="panel inspector">
      <div className="panel-title">{node ? 'Component' : edgeId ? 'Link' : 'Inspector'}</div>
      {extensionViews.views.length > 0 && (
        <div className="tabs">
          <button
            className={!extensionViews.selected ? 'active' : ''}
            onClick={() => extensionViews.setSelected(null)}
          >
            Component
          </button>
          {extensionViews.views.map((view) => (
            <button
              key={view.id}
              data-extension-view-tab={view.id}
              className={extensionViews.selected === view.id ? 'active' : ''}
              onClick={() => extensionViews.setSelected(view.id)}
            >
              {view.title}
            </button>
          ))}
        </div>
      )}
      {extensionViews.selected ? (
        <ExtensionView id={extensionViews.selected} />
      ) : node ? (
        <ComponentInspector key={node.id} node={node} />
      ) : edgeId ? (
        <LinkInspector edgeId={edgeId} />
      ) : (
        <div className="hint flush">
          {project ? (
            <>
              Select a component to edit it and manage its terminals.
              <br />
              <br />
              Links mean “depends on”. Agent terminals (like Claude) get the component's notes and
              its related components as context.
            </>
          ) : (
            'Open a project folder to begin.'
          )}
        </div>
      )}
    </div>
  )
}
