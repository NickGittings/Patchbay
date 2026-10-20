import {
  AGENT_ROLES,
  type AgentRole,
  type AgentRoles,
  type DeviceManifest,
  type TerminalSpec,
} from '../types'
import { agentDevices, planTerminals } from './plan'

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

/** [`roleDevice`]'s preset as an agent terminal, as planners and job agents launch it. */
export function roleTerminal(
  devices: DeviceManifest[],
  roles: AgentRoles,
  role: AgentRole,
): TerminalSpec | undefined {
  const id = roleDevice(devices, roles, role)?.id
  return planTerminals(devices).find((t) => t.id === id)
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

/** Saved preset ids, preserving order and dropping malformed/duplicate entries. */
export function restoredPresetIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === 'string' && !!id))]
    : []
}

/** Known role entries from a saved object, shared by layout and Auto restoration. */
function restoredRoles<T>(
  value: unknown,
  restore: (value: unknown, role: AgentRole) => T | undefined,
): Partial<Record<AgentRole, T>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Partial<Record<AgentRole, T>> = {}
  for (const role of AGENT_ROLES) {
    const valid = restore((value as Record<string, unknown>)[role], role)
    if (valid !== undefined) out[role] = valid
  }
  return out
}

/** A saved layout's assignments, dropping anything malformed. */
export function restoredAgentRoles(value: unknown): AgentRoles {
  return restoredRoles(value, (ids, role) => {
    const valid = restoredPresetIds(ids)
    return valid.length ? (role === 'review' ? valid : valid.slice(0, 1)) : undefined
  })
}

/** Per-stage Auto presets; older runs have no per-stage assignments. */
export function restoredAgents(value: unknown): Partial<Record<AgentRole, string>> | undefined {
  const agents = restoredRoles(value, (id) => (typeof id === 'string' && id ? id : undefined))
  return Object.keys(agents).length ? agents : undefined
}
