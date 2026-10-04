import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  MarkerType,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react'
import { create } from 'zustand'
import type {
  Component,
  ComponentData,
  DeviceManifest,
  GitStatus,
  Link,
  Project,
  SessionState,
  TerminalSpec,
  View,
} from './types'
import { sessionId } from './types'

export type FlowNode = Node<ComponentData, 'component'>
export type FlowEdge = Edge<{ label?: string | null }>

interface State {
  project: { name: string; root: string } | null
  nodes: FlowNode[]
  edges: FlowEdge[]
  devices: DeviceManifest[]
  sessions: Record<string, SessionState>
  gitChanges: Record<string, number>
  /** Repo folder name for components outside the project root's repo. */
  repos: Record<string, string>
  selectedId: string | null
  selectedEdgeId: string | null
  activeSession: string | null
  view: View
  highlighted: string[]
  planStartedWith: Record<string, string>
  setView: (view: View) => void
  toggleHighlight: (id: string) => void
  clearHighlights: () => void
  markPlanStarted: (sid: string, ids: string[]) => void
  dirty: boolean
  message: string

  loadProject: (p: Project) => void
  syncProject: (p: Project) => void
  toProject: () => Project
  onNodesChange: (changes: NodeChange<FlowNode>[]) => void
  onEdgesChange: (changes: EdgeChange<FlowEdge>[]) => void
  onConnect: (c: Connection) => void
  addComponent: (position: { x: number; y: number }) => void
  updateComponent: (id: string, patch: Partial<ComponentData>) => void
  addTerminal: (componentId: string, device: DeviceManifest | null) => void
  updateTerminal: (componentId: string, terminalId: string, patch: Partial<TerminalSpec>) => void
  removeTerminal: (componentId: string, terminalId: string) => void
  setEdgeLabel: (id: string, label: string) => void
  select: (id: string | null) => void
  selectEdge: (id: string | null) => void
  setActiveSession: (id: string | null) => void
  setSession: (id: string, s: SessionState) => void
  setGitChanges: (c: Record<string, number>) => void
  setGitStatus: (s: GitStatus) => void
  setDevices: (d: DeviceManifest[]) => void
  setMessage: (m: string) => void
  markSaved: () => void
}

let counter = 0
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}`

const linkToEdge = (l: Link): FlowEdge => ({
  id: l.id,
  source: l.source,
  target: l.target,
  label: l.label ?? undefined,
  data: { label: l.label },
  markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
})

const componentToNode = ({ id, position, ...data }: Component): FlowNode => ({
  id,
  type: 'component',
  position,
  data,
})

const mapNode = (nodes: FlowNode[], id: string, f: (d: ComponentData) => ComponentData) =>
  nodes.map((n) => (n.id === id ? { ...n, data: f(n.data) } : n))

export const useStore = create<State>((set, get) => ({
  project: null,
  nodes: [],
  edges: [],
  devices: [],
  sessions: {},
  gitChanges: {},
  repos: {},
  selectedId: null,
  selectedEdgeId: null,
  activeSession: null,
  dirty: false,
  message: '',
  view: 'navigation',
  highlighted: [],
  planStartedWith: {},

  loadProject: (p) =>
    set({
      project: { name: p.name, root: p.root },
      nodes: p.components.map(componentToNode),
      edges: p.links.map(linkToEdge),
      view: 'navigation',
      highlighted: [],
      planStartedWith: {},
      sessions: {},
      gitChanges: {},
      repos: {},
      selectedId: null,
      selectedEdgeId: null,
      activeSession: null,
      dirty: false,
    }),

  syncProject: (p) =>
    set((s) => {
      const selected = new Set(s.nodes.filter((n) => n.selected).map((n) => n.id))
      const selectedEdges = new Set(s.edges.filter((e) => e.selected).map((e) => e.id))
      return {
        project: { name: p.name, root: p.root },
        nodes: p.components.map((c) => ({ ...componentToNode(c), selected: selected.has(c.id) })),
        edges: p.links.map((l) => ({ ...linkToEdge(l), selected: selectedEdges.has(l.id) })),
      }
    }),

  toProject: () => {
    const { project, nodes, edges } = get()
    return {
      schemaVersion: 2,
      name: project?.name ?? 'project',
      root: project?.root ?? '',
      components: nodes.map((n) => ({
        id: n.id,
        position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
        name: n.data.name,
        kind: n.data.kind,
        path: n.data.path,
        notes: n.data.notes,
        terminals: n.data.terminals,
      })),
      links: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.data?.label || null,
      })),
    }
  },

  onNodesChange: (changes) => {
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id)
    const edits = changes.some((c) => c.type === 'remove' || (c.type === 'position' && !c.dragging))
    set((s) => ({
      nodes: applyNodeChanges(changes, s.nodes),
      highlighted: removed.length
        ? s.highlighted.filter((id) => !removed.includes(id))
        : s.highlighted,
      selectedId: removed.includes(s.selectedId ?? '') ? null : s.selectedId,
      dirty: s.dirty || edits,
    }))
  },
  onEdgesChange: (changes) =>
    set((s) => ({
      edges: applyEdgeChanges(changes, s.edges),
      dirty: s.dirty || changes.some((c) => c.type === 'remove'),
    })),
  onConnect: (c) =>
    set((s) => ({
      edges: addEdge<FlowEdge>(
        linkToEdge({ id: newId('link'), source: c.source, target: c.target }),
        s.edges,
      ),
      dirty: true,
    })),

  addComponent: (position) => {
    const id = newId('component')
    const node: FlowNode = {
      id,
      type: 'component',
      position,
      data: {
        name: 'New component',
        kind: 'other',
        path: '.',
        notes: '',
        terminals: [{ id: 'shell', name: 'Shell', command: '', kind: 'shell' }],
      },
    }
    set((s) => ({ nodes: [...s.nodes, node], selectedId: id, selectedEdgeId: null, dirty: true }))
  },
  updateComponent: (id, patch) =>
    set((s) => ({ nodes: mapNode(s.nodes, id, (d) => ({ ...d, ...patch })), dirty: true })),

  addTerminal: (componentId, device) => {
    const terminal: TerminalSpec = {
      id: newId(device?.id ?? 'task'),
      name: device?.name ?? 'Task',
      command: device?.command ?? '',
      kind: device?.kind ?? 'task',
    }
    set((s) => ({
      nodes: mapNode(s.nodes, componentId, (d) => ({
        ...d,
        terminals: [...d.terminals, terminal],
      })),
      activeSession: sessionId(componentId, terminal.id),
      dirty: true,
    }))
  },
  updateTerminal: (componentId, terminalId, patch) =>
    set((s) => ({
      nodes: mapNode(s.nodes, componentId, (d) => ({
        ...d,
        terminals: d.terminals.map((t) => (t.id === terminalId ? { ...t, ...patch } : t)),
      })),
      dirty: true,
    })),
  removeTerminal: (componentId, terminalId) =>
    set((s) => ({
      nodes: mapNode(s.nodes, componentId, (d) => ({
        ...d,
        terminals: d.terminals.filter((t) => t.id !== terminalId),
      })),
      dirty: true,
    })),

  setEdgeLabel: (id, label) =>
    set((s) => ({
      edges: s.edges.map((e) =>
        e.id === id ? { ...e, label: label || undefined, data: { label } } : e,
      ),
      dirty: true,
    })),

  setView: (view) => set({ view }),
  toggleHighlight: (id) =>
    set((s) => ({
      highlighted: s.highlighted.includes(id)
        ? s.highlighted.filter((highlightedId) => highlightedId !== id)
        : s.nodes.some((n) => n.id === id)
          ? [...s.highlighted, id]
          : s.highlighted,
    })),
  clearHighlights: () => set({ highlighted: [] }),
  markPlanStarted: (sid, ids) =>
    set((s) => ({
      planStartedWith: { ...s.planStartedWith, [sid]: [...ids].sort().join(',') },
    })),

  select: (id) => {
    if (!id) return set({ selectedId: null })
    const current = get().activeSession
    const node = get().nodes.find((n) => n.id === id)
    const keep = current?.startsWith(`${id}/`)
    const first = node?.data.terminals[0]
    set({
      selectedId: id,
      selectedEdgeId: null,
      activeSession: keep ? current : first ? sessionId(id, first.id) : null,
    })
  },
  selectEdge: (selectedEdgeId) => set({ selectedEdgeId, selectedId: null }),
  setActiveSession: (activeSession) => set({ activeSession }),
  setSession: (id, st) => set((s) => ({ sessions: { ...s.sessions, [id]: st } })),
  setGitChanges: (gitChanges) => set({ gitChanges }),
  setGitStatus: ({ changes, repos }) => set({ gitChanges: changes, repos }),
  setDevices: (devices) => set({ devices }),
  setMessage: (message) => set({ message }),
  markSaved: () => set({ dirty: false }),
}))
