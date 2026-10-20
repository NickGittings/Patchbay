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
import { useEffect, useState } from 'react'
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
  const { fitView } = useReactFlow()
  const [tween, setTween] = useState<{ from: Record<string, Position>; t: number } | null>(null)
  useEffect(() => {
    let frame = 0
    const off = onArranged((id, from) => {
      if (id !== projectId) return
      cancelAnimationFrame(frame)
      const start = performance.now()
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ARRANGE_MS)
        setTween(t < 1 ? { from, t: ease(t) } : null)
        if (t < 1) frame = requestAnimationFrame(step)
      }
      setTween({ from, t: 0 })
      frame = requestAnimationFrame(step)
      void fitView({ padding: 0.25, maxZoom: 1, duration: ARRANGE_MS })
    })
    return () => {
      off()
      cancelAnimationFrame(frame)
    }
  }, [fitView, projectId])
  return tween
}

function tweened(nodes: FlowNode[], tween: ReturnType<typeof useArranging>) {
  if (!tween) return nodes
  return nodes.map((n) => {
    const from = tween.from[n.id]
    if (!from) return n
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
  const tween = useArranging(project?.id)

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
        onNodesChange={onNodesChange}
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
