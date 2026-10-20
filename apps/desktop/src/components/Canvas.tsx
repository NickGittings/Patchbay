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
import { useCallback, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { onArranged } from '../lib/arrange'
import type { Position } from '../lib/layout'
import { KIND_COLOR } from '../lib/display'
import { showsInspector } from '../lib/panels'
import { useStore, type FlowNode } from '../store'
import ComponentNode from './nodes/ComponentNode'
import Welcome from './Welcome'
import { removeComponents } from '../lib/maintenance'

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
    projectId: string
    from: Record<string, Position>
    t: number
    fit: boolean
  } | null>(null)
  const [previousProjectId, setPreviousProjectId] = useState(projectId)
  if (projectId !== previousProjectId) {
    setPreviousProjectId(projectId)
    setTween(null)
  }
  useEffect(() => {
    let frame = 0
    const off = onArranged((id, from) => {
      if (id !== projectId) return
      cancelAnimationFrame(frame)
      // Another arrangement may interrupt this one; start where the nodes are drawn now.
      from = Object.fromEntries(
        Object.entries(from).map(([id, position]) => [id, getNode(id)?.position ?? position]),
      )
      const start = performance.now()
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ARRANGE_MS)
        setTween((current) => (current ? { ...current, t: ease(t) } : null))
        if (t < 1) frame = requestAnimationFrame(step)
      }
      setTween({ projectId: id, from, t: 0, fit: true })
      frame = requestAnimationFrame(step)
    })
    return () => {
      off()
      cancelAnimationFrame(frame)
    }
  }, [getNode, projectId])
  useEffect(() => {
    if (!tween || tween.projectId !== projectId || tween.t !== 1) return
    // Let React Flow receive the final positions before it queues a fit. Both this render and
    // the next show the destination, so fitting cannot frame the tween's starting positions.
    const frame = requestAnimationFrame(() => {
      if (tween.fit) void fitView({ padding: 0.25, maxZoom: 1, duration: ARRANGE_MS })
      setTween(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [fitView, projectId, tween])
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
  return { tween: tween?.projectId === projectId ? tween : null, interrupt }
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
    view,
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
      view: s.view,
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
  const { tween, interrupt } = useArranging(project?.id)
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

  if (!project) return <Welcome />

  const planning = view === 'plan'
  const scope = new Set(highlighted)
  const visibleEdges = planning
    ? edges.map((e) => ({
        ...e,
        selected: false,
        className: scope.has(e.source) && scope.has(e.target) ? 'plan-active-edge' : '',
      }))
    : edges

  return (
    <div className="canvas">
      <ReactFlow
        nodes={tweened(planning ? nodes.map((n) => ({ ...n, selected: false })) : nodes, tween)}
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
        onSelectionDragStart={(_, dragged) => updateDrag(dragged, true)}
        onNodeDragStop={(_, _node, dragged) => updateDrag(dragged, false)}
        onSelectionDragStop={(_, dragged) => updateDrag(dragged, false)}
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
        {!planning && !inspectorShown && (
          <Panel position="top-right">
            <button
              className="inspector-toggle"
              onClick={() => useStore.setState({ inspector: true })}
            >
              Inspector
            </button>
          </Panel>
        )}
      </ReactFlow>
    </div>
  )
}
