import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
} from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { KIND_COLOR } from '../lib/display'
import { useStore, type FlowNode } from '../store'
import ComponentNode from './nodes/ComponentNode'
import Welcome from './Welcome'

const nodeTypes = { component: ComponentNode }

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
  const { project, nodes, edges, onNodesChange, onEdgesChange, onConnect, select, selectEdge } =
    useStore(
      useShallow((s) => ({
        project: s.project,
        nodes: s.nodes,
        edges: s.edges,
        onNodesChange: s.onNodesChange,
        onEdgesChange: s.onEdgesChange,
        onConnect: s.onConnect,
        select: s.select,
        selectEdge: s.selectEdge,
      })),
    )

  if (!project) return <Welcome />

  return (
    <div className="canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeClick={(_, n) => select(n.id)}
        onEdgeClick={(_, e) => selectEdge(e.id)}
        onPaneClick={() => {
          select(null)
          selectEdge(null)
        }}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        deleteKeyCode={['Backspace', 'Delete']}
        defaultEdgeOptions={{ style: { strokeWidth: 2 } }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a2d36" />
        <Controls />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => KIND_COLOR[(n as FlowNode).data.kind]}
          maskColor="rgba(0,0,0,0.5)"
          style={{ width: 140, height: 90 }}
        />
      </ReactFlow>
    </div>
  )
}
