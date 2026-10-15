import { AGENT_ROLES, type AgentRole, type AgentRoles, type DeviceManifest } from '../types'
import { agentDevices } from './plan'

export const ROLE_LABELS: Record<AgentRole, string> = {
  plan: 'Plan',
  implement: 'Implement',
  review: 'Review',
  fix: 'Fix',
  merge: 'Merge',
}

/** Installed presets assigned to `role`, in order; empty when it has none or all are gone. */
function assigned(devices: DeviceManifest[], roles: AgentRoles, role: AgentRole) {
  const agents = agentDevices(devices)
  return (roles[role] ?? []).flatMap((id) => agents.find((d) => d.id === id) ?? [])
}

/**
 * The preset `role` launches: its assigned one while installed, else the caller's `fallback`
 * (the planner's agent for implement, the reviewer's provider for fix), else the first preset.
 */
export function roleDevice(
  devices: DeviceManifest[],
  roles: AgentRoles,
  role: AgentRole,
  fallback?: DeviceManifest,
): DeviceManifest {
  return assigned(devices, roles, role)[0] ?? fallback ?? agentDevices(devices)[0]
}

/** Every reviewer assigned to `role`, else the single preset [`roleDevice`] picks. */
export function roleDevices(
  devices: DeviceManifest[],
  roles: AgentRoles,
  role: AgentRole,
): DeviceManifest[] {
  const all = assigned(devices, roles, role)
  return all.length
    ? role === 'review'
      ? all
      : all.slice(0, 1)
    : [roleDevice(devices, roles, role)]
}

/** A saved layout's assignments, dropping anything malformed. */
export function restoredAgentRoles(value: unknown): AgentRoles {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: AgentRoles = {}
  for (const role of AGENT_ROLES) {
    const ids = (value as Record<string, unknown>)[role]
    if (!Array.isArray(ids)) continue
    const valid = [...new Set(ids.filter((id): id is string => typeof id === 'string' && !!id))]
    if (valid.length) out[role] = role === 'review' ? valid : valid.slice(0, 1)
  }
  return out
}
