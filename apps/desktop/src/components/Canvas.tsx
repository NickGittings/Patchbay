import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { onArranged } from '../lib/arrange'
import type { Position } from '../lib/layout'
import { KIND_COLOR } from '../lib/display'
import { showsInspector } from '../lib/panels'
import { useStore, type FlowNode } from '../store'
import ComponentNode from './nodes/ComponentNode'
import Welcome from './Welcome'
import EmptyState from './EmptyState'
import { useAddFolder, useRescanProject } from '../lib/project'
import { removeComponents } from '../lib/maintenance'
import { FOCUS_COMPONENT_EVENT, takeFocusRequest } from '../lib/navigation'

const nodeTypes = { component: ComponentNode }

const ARRANGE_MS = 400

const ease = (t: number) => 1 - (1 - t) ** 3

/**
 * While an arrangement of this project settles, where its moved nodes are drawn: on their way from
 * where they were, so edges follow them. Null otherwise. The store already holds the end state.
 */
function useArranging(projectId: string | undefined) {
  const { fitView, getNode } = useReactFlow()
  const [tween, setTween] = useState<{
    from: Record<string, Position>
    t: number
    fit: boolean
  } | null>(null)
  const current = useRef(tween)
  current.current = tween
  useEffect(() => {
    let frame = 0
    const off = onArranged((id, moved) => {
      if (id !== projectId) return
      cancelAnimationFrame(frame)
      // Another arrangement may interrupt this one: nodes still on their way keep going, and
      // every node starts where it is drawn now.
      const from: Record<string, Position> = {}
      for (const [id, position] of Object.entries({ ...current.current?.from, ...moved }))
        from[id] = getNode(id)?.position ?? position
      const start = performance.now()
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ARRANGE_MS)
        setTween((current) => (current ? { ...current, t: ease(t) } : null))
        if (t < 1) frame = requestAnimationFrame(step)
      }
      setTween({ from, t: 0, fit: true })
      frame = requestAnimationFrame(step)
    })
    return () => {
      off()
      cancelAnimationFrame(frame)
    }
  }, [getNode, projectId])
  useEffect(() => {
    if (!tween || tween.t !== 1) return
    // Let React Flow receive the final positions before it queues a fit. Both this render and
    // the next show the destination, so fitting cannot frame the tween's starting positions.
    const frame = requestAnimationFrame(() => {
      if (tween.fit) void fitView({ padding: 0.25, maxZoom: 1, duration: ARRANGE_MS })
      setTween(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [fitView, tween])
  const interrupt = useCallback((ids: string[]) => {
    if (!ids.length) return
    setTween((current) => {
      if (!current) return null
      const from = { ...current.from }
      for (const id of ids) delete from[id]
      // A user taking control of the map also cancels the automatic viewport move.
      return { ...current, from, fit: false }
    })
  }, [])
  /** A pan or zoom by the user cancels the automatic viewport move too. */
  const keepViewport = useCallback(
    () => setTween((current) => (current?.fit ? { ...current, fit: false } : current)),
    [],
  )
  return { tween, interrupt, keepViewport }
}

/** Centers the component `focusComponent` asked for, on mount (after a view switch) or later. */
function useFocusRequests() {
  const { getNode, setCenter } = useReactFlow()
  useEffect(() => {
    let frame = 0
    const take = () => {
      cancelAnimationFrame(frame)
      // A frame later, so a canvas mounted by the request has measured its nodes.
      frame = requestAnimationFrame(() => {
        const id = takeFocusRequest()
        const node = id ? getNode(id) : undefined
        if (!node) return
        const w = node.measured?.width ?? 260
        const h = node.measured?.height ?? 120
        void setCenter(node.position.x + w / 2, node.position.y + h / 2, {
          zoom: 1,
          duration: 300,
        })
      })
    }
    take()
    window.addEventListener(FOCUS_COMPONENT_EVENT, take)
    return () => {
      window.removeEventListener(FOCUS_COMPONENT_EVENT, take)
      cancelAnimationFrame(frame)
    }
  }, [getNode, setCenter])
}

function tweened(nodes: FlowNode[], tween: ReturnType<typeof useArranging>['tween']) {
  if (!tween || tween.t === 1) return nodes
  return nodes.map((n) => {
    const from = tween.from[n.id]
    if (!from || n.dragging) return n
    return {
      ...n,
      position: {
        x: from.x + (n.position.x - from.x) * tween.t,
        y: from.y + (n.position.y - from.y) * tween.t,
      },
    }
  })
}

/** One link per pair, never to self. */
function isValidConnection(c: Connection | Edge) {
  if (c.source === c.target) return false
  return !useStore
    .getState()
    .edges.some(
      (e) =>
        (e.source === c.source && e.target === c.target) ||
        (e.source === c.target && e.target === c.source),
    )
}

export default function Canvas() {
  const {
    project,
    planning,
    highlighted,
    toggleHighlight,
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    select,
    selectEdge,
  } = useStore(
    useShallow((s) => ({
      project: s.project,
      planning: s.simpleMode || s.view === 'plan',
      highlighted: s.highlighted,
      toggleHighlight: s.toggleHighlight,
      nodes: s.nodes,
      edges: s.edges,
      onNodesChange: s.onNodesChange,
      onEdgesChange: s.onEdgesChange,
      onConnect: s.onConnect,
      select: s.select,
      selectEdge: s.selectEdge,
    })),
  )
  const inspectorShown = useStore(showsInspector)
  const { tween, interrupt, keepViewport } = useArranging(project?.id)
  useFocusRequests()
  const rescan = useRescanProject()
  const addRepo = useAddFolder()
  // React Flow's node drag callbacks also cover selection-box drags.
  const updateDrag = (dragged: FlowNode[], dragging: boolean) => {
    if (dragging) interrupt(dragged.map((n) => n.id))
    // The store holds the destination; a drag must start at the displayed position instead.
    onNodesChange(
      dragged.map((n) => ({
        id: n.id,
        type: 'position',
        position: n.position,
        dragging,
      })),
    )
  }

  // Stable between tween frames, so React Flow only re-adopts the nodes that move.
  const shownNodes = useMemo(
    () => (planning ? nodes.map((n) => ({ ...n, selected: false })) : nodes),
    [nodes, planning],
  )
  const visibleEdges = useMemo(() => {
    if (!planning) return edges
    const scope = new Set(highlighted)
    return edges.map((e) => ({
      ...e,
      selected: false,
      className: scope.has(e.source) && scope.has(e.target) ? 'plan-active-edge' : '',
    }))
  }, [edges, highlighted, planning])

  if (!project) return <Welcome />

  return (
    <div className="canvas">
      <ReactFlow
        nodes={tweened(shownNodes, tween)}
        edges={visibleEdges}
        nodeTypes={nodeTypes}
        onBeforeDelete={async ({ nodes: removedNodes, edges: removedEdges }) => {
          if (!removedNodes.length) return true
          const projectId = project.id
          const accepted = await removeComponents(
            removedNodes.map((n) => n.id),
            projectId,
          )
          if (accepted && projectId) {
            const s = useStore.getState()
            const origin = s.captureProjects()[projectId]?.state
            if (origin)
              s.patchProject(projectId, {
                edges: origin.edges.filter(
                  (e) => !removedEdges.some((removed) => removed.id === e.id),
                ),
                dirty: true,
              })
          }
          return false
        }}
        onNodesChange={(changes) => {
          interrupt(changes.filter((c) => c.type === 'position').map((c) => c.id))
          onNodesChange(changes)
        }}
        onNodeDragStart={(_, _node, dragged) => updateDrag(dragged, true)}
        onNodeDragStop={(_, _node, dragged) => updateDrag(dragged, false)}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeClick={(_, n) => (planning ? toggleHighlight(n.id) : select(n.id))}
        onEdgeClick={(_, e) => {
          if (!planning) selectEdge(e.id)
        }}
        onPaneClick={() => {
          if (planning) return
          select(null)
          selectEdge(null)
        }}
        colorMode="dark"
        defaultViewport={useStore.getState().viewport}
        onMoveStart={(event) => {
          // Programmatic moves, such as the fit itself, come without an event.
          if (event) keepViewport()
        }}
        onMoveEnd={(_, viewport) => useStore.getState().setViewport(viewport)}
        fitView={!useStore.getState().viewport}
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        nodesConnectable={!planning}
        nodesDraggable={!planning}
        elementsSelectable={!planning}
        deleteKeyCode={planning ? null : ['Backspace', 'Delete']}
        defaultEdgeOptions={{ style: { strokeWidth: 2 } }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--border-strong)"
        />
        <Controls showInteractive={!planning} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => KIND_COLOR[(n as FlowNode).data.kind]}
          style={{ width: 140, height: 90 }}
        />
        {nodes.length === 0 && (
          <Panel position="top-center" className="canvas-empty">
            <EmptyState
              icon="◇"
              title="No components"
              actions={
                !planning && (
                  <>
                    <button onClick={() => void rescan()}>Rescan</button>
                    <button onClick={() => void addRepo()}>Add repo…</button>
                  </>
                )
              }
            >
              Rescan the project or add a repository to map its parts.
            </EmptyState>
          </Panel>
        )}
        {!planning && !inspectorShown && (
          <Panel position="top-right">
            <button
              className="inspector-toggle"
              title="Show Inspector"
              aria-label="Show Inspector"
              onClick={() => useStore.setState({ inspector: true })}
            >
              ◧
            </button>
          </Panel>
        )}
      </ReactFlow>
    </div>
  )
}
