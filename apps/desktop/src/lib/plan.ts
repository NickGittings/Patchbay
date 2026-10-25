import type { DeviceManifest, TerminalSpec } from '../types'

/** The planner when no agent preset is installed. */
const FALLBACK_AGENT: DeviceManifest = {
  id: 'claude',
  name: 'Claude',
  category: 'agent',
  command: 'claude',
  kind: 'agent',
  source: 'builtin',
}

/** Agent presets for planning and implementation, else the built-in Claude. */
export const agentDevices = (devices: DeviceManifest[]) => {
  const agents = devices.filter((d) => d.kind === 'agent')
  return agents.length ? agents : [FALLBACK_AGENT]
}

/** Planner terminals are session UI state, never persisted on a component. */
export function planTerminals(devices: DeviceManifest[]): TerminalSpec[] {
  return agentDevices(devices).map(({ id, name, command, adapter }) => ({
    id,
    name,
    command,
    adapter,
    kind: 'agent',
  }))
}

/** The agent preset behind planner terminal `id`, so components get the planner's own agent. */
export function plannerDevice(devices: DeviceManifest[], id: string): DeviceManifest {
  const agents = agentDevices(devices)
  return agents.find((d) => d.id === id) ?? agents[0]
}

/**
 * The components implemented alongside `componentId`: the highlighted set when it
 * includes the component and others, so each agent's briefing names its peers.
 */
export function peersFor(componentId: string, highlighted: string[]): string[] | undefined {
  return highlighted.length > 1 && highlighted.includes(componentId) ? highlighted : undefined
}

type PlanEdge = { source: string; target: string }
let lastHighlighted: string[] | undefined
let lastEdges: PlanEdge[] | undefined
let lastNearby = new Set<string>()

let lastChanges: Record<string, number> | null = null
let lastAffectedEdges: PlanEdge[] | null = null
let lastAffected = new Set<string>()

/**
 * Unchanged components that depend, transitively, on a changed one (like `Project::dependents`).
 * Shared across nodes; recomputed only when the counts or edges change.
 */
export function affectedIds(changes: Record<string, number>, edges: PlanEdge[]): Set<string> {
  if (changes === lastChanges && edges === lastAffectedEdges) return lastAffected
  const changed = new Set(Object.keys(changes).filter((id) => changes[id] > 0))
  const affected = new Set<string>()
  const queue = [...changed]
  while (queue.length) {
    const id = queue.pop()!
    for (const e of edges)
      if (e.target === id && !changed.has(e.source) && !affected.has(e.source)) {
        affected.add(e.source)
        queue.push(e.source)
      }
  }
  lastChanges = changes
  lastAffectedEdges = edges
  lastAffected = affected
  return affected
}

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
