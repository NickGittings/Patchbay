import { open } from '@tauri-apps/plugin-dialog'
import { useState } from 'react'
import { describeTerminal, KIND_COLOR, terminalHealth } from '../lib/display'
import { componentContext } from '../lib/ipc'
import { startTerminal, stopTerminal } from '../lib/sessions'
import { useStore, type FlowNode } from '../store'
import { COMPONENT_KINDS, sessionId, type ComponentKind, type TerminalKind } from '../types'

const TERMINAL_KINDS: TerminalKind[] = ['shell', 'task', 'agent']

/** Folder picker that stores the path relative to the project root. */
async function pickFolder(root: string): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, defaultPath: root })
  if (typeof picked !== 'string') return null
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '')
  const [r, p] = [norm(root), norm(picked)]
  if (p === r) return '.'
  if (!p.startsWith(`${r}/`)) {
    useStore.getState().setMessage('Pick a folder inside the project')
    return null
  }
  return p.slice(r.length + 1)
}

function ComponentInspector({ node }: { node: FlowNode }) {
  const { id, data } = node
  const root = useStore((s) => s.project?.root ?? '')
  const devices = useStore((s) => s.devices)
  const sessions = useStore((s) => s.sessions)
  const edges = useStore((s) => s.edges)
  const nodes = useStore((s) => s.nodes)
  const { updateComponent, updateTerminal, removeTerminal, addTerminal, setActiveSession } =
    useStore.getState()
  const [context, setContext] = useState<string | null>(null)

  const nameOf = (nid: string) => nodes.find((n) => n.id === nid)?.data.name ?? nid
  const dependsOn = edges.filter((e) => e.source === id)
  const usedBy = edges.filter((e) => e.target === id)

  const loadContext = async () => {
    setContext(await componentContext(useStore.getState().toProject(), id))
  }

  return (
    <>
      <label>
        Name
        <input value={data.name} onChange={(e) => updateComponent(id, { name: e.target.value })} />
      </label>
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
              const path = await pickFolder(root)
              if (path) updateComponent(id, { path })
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
        return (
          <div key={t.id} className={`terminal-row health-${terminalHealth(session)}`}>
            <div className="row">
              <span className="status-dot" />
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
  const node = useStore((s) => s.nodes.find((n) => n.id === s.selectedId))
  const edgeId = useStore((s) => s.selectedEdgeId)
  const project = useStore((s) => s.project)

  return (
    <div className="panel inspector">
      <div className="panel-title">{node ? 'Component' : edgeId ? 'Link' : 'Inspector'}</div>
      {node ? (
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
