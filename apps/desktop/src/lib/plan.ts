import type { DeviceManifest, TerminalSpec } from '../types'

/** Planner terminals are session UI state, never persisted on a component. */
export function planTerminals(devices: DeviceManifest[]): TerminalSpec[] {
  const agents = devices.filter((d) => d.kind === 'agent')
  return agents.length
    ? agents.map(({ id, name, command }) => ({ id, name, command, kind: 'agent' }))
    : [{ id: 'claude', name: 'Claude', command: 'claude', kind: 'agent' }]
}

/** Neighbours of the highlighted set, excluding the set itself. */
export function nearbyIds(
  highlighted: string[],
  edges: { source: string; target: string }[],
): Set<string> {
  const scope = new Set(highlighted)
  const nearby = new Set<string>()
  for (const e of edges) {
    if (scope.has(e.source) && !scope.has(e.target)) nearby.add(e.target)
    if (scope.has(e.target) && !scope.has(e.source)) nearby.add(e.source)
  }
  return nearby
}
