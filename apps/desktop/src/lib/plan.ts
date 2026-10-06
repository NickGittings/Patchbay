import type { DeviceManifest, TerminalSpec } from '../types'

/** Planner terminals are session UI state, never persisted on a component. */
export function planTerminals(devices: DeviceManifest[]): TerminalSpec[] {
  const agents = devices.filter((d) => d.kind === 'agent')
  return agents.length
    ? agents.map(({ id, name, command, adapter }) => ({
        id,
        name,
        command,
        adapter,
        kind: 'agent',
      }))
    : [{ id: 'claude', name: 'Claude', command: 'claude', kind: 'agent' }]
}

type PlanEdge = { source: string; target: string }
let lastHighlighted: string[] | undefined
let lastEdges: PlanEdge[] | undefined
let lastNearby = new Set<string>()

/** Shared across nodes; recompute only when highlights or edges change. */
export function nearbyIds(highlighted: string[], edges: PlanEdge[]): Set<string> {
  if (highlighted === lastHighlighted && edges === lastEdges) return lastNearby
  const scope = new Set(highlighted)
  const nearby = new Set<string>()
  for (const e of highlighted.length ? edges : []) {
    if (scope.has(e.source) && !scope.has(e.target)) nearby.add(e.target)
    if (scope.has(e.target) && !scope.has(e.source)) nearby.add(e.source)
  }
  lastHighlighted = highlighted
  lastEdges = edges
  lastNearby = nearby
  return lastNearby
}
