import {
  COORDINATOR_SCOPE,
  MERGE_SCOPE,
  PLAN_SCOPE,
  REVIEW_SCOPE,
  TASK_ROOT_SCOPE,
  WORKER_SCOPE,
  type SessionRecord,
} from '../types'
import { profileHookProvider } from './agentProfiles'
import { useChatTeams, type ChatTeam } from './chatTeams'
import type { ProviderRun } from './orchestration'
import { sessionRole } from './sessionList'

/** A provider as shown to people. */
export function providerLabel(provider: string | null | undefined) {
  return provider === 'codex' ? 'Codex' : provider ? 'Claude' : undefined
}

/** The agent's provider as shown to people: its launch profile's, else its adapter's. */
export function agentProviderLabel(record: SessionRecord | undefined) {
  return providerLabel(
    record && (profileHookProvider(record.spec.command) ?? record.metadata.adapter),
  )
}

export type ChatRoleKey =
  'lead' | 'builder' | 'subBuilder' | 'planner' | 'reviewer' | 'merge' | 'agent'

export const ROLE_LABELS: Record<ChatRoleKey, string> = {
  lead: 'Lead',
  builder: 'Builder',
  subBuilder: 'Sub-builder',
  planner: 'Planner',
  reviewer: 'Reviewer',
  merge: 'Merge agent',
  agent: 'Agent',
}

/** Workflow agents keep the role of the scope they were launched in. */
const SCOPE_ROLES: Record<string, ChatRoleKey> = {
  [PLAN_SCOPE]: 'planner',
  [REVIEW_SCOPE]: 'reviewer',
  [MERGE_SCOPE]: 'merge',
}

/** Whether `sid` leads, or is about to lead, a team that is still going. */
export function leadsActiveTeam(sid: string, teams: Record<string, readonly ChatTeam[]>) {
  return Object.values(teams).some((list) =>
    list.some(
      (t) =>
        (t.state === 'running' || t.state === 'paused') &&
        (t.lead.sessionId === sid || t.reset?.nextSession === sid),
    ),
  )
}

/** Whether a Chat team adopted `record` or launched it as one of its provider run's jobs. */
export function teamWorker(
  record: SessionRecord | undefined,
  teams: readonly ChatTeam[] = [],
  runs: readonly ProviderRun[] = [],
) {
  return (
    !!record &&
    (teams.some((t) => Object.hasOwn(t.scopes ?? {}, record.id)) ||
      runs.some(
        (r) =>
          teams.some((t) => t.id === r.chatTeam) && r.jobs.some((j) => j.sessionId === record.id),
      ))
  )
}

/** Use the build role as the display name for a root Builder or a Sub-builder. */
export function namedBuilder(record: SessionRecord | undefined, roleKey: ChatRoleKey) {
  return (
    roleKey === 'subBuilder' ||
    (roleKey === 'builder' &&
      !!record &&
      (record.metadata.componentId === COORDINATOR_SCOPE ||
        (record.metadata.componentId === TASK_ROOT_SCOPE &&
          sessionRole(record.metadata).role === 'Build')))
  )
}

/**
 * Roles come from durable membership, else the launch scope, never the workflow stage or selected
 * terminal, so an agent reads the same in Chat and the regular views.
 */
function chatRoleKey(
  record: SessionRecord | undefined,
  teams: readonly ChatTeam[] = [],
  runs: readonly ProviderRun[] = [],
): ChatRoleKey {
  return teams.some((t) => t.lead.sessionId === record?.id)
    ? 'lead'
    : teamWorker(record, teams, runs) || record?.metadata.componentId === WORKER_SCOPE
      ? 'subBuilder'
      : record && Object.hasOwn(SCOPE_ROLES, record.metadata.componentId)
        ? SCOPE_ROLES[record.metadata.componentId]
        : // Build, Fix and coordinator sessions share the Builder role.
          record &&
            record.spec.purpose !== 'chat' &&
            sessionRole(record.metadata).tone === 'implement'
          ? 'builder'
          : 'agent'
}

export function chatIdentity(
  record: SessionRecord | undefined,
  teams: readonly ChatTeam[] = [],
  runs: readonly ProviderRun[] = [],
) {
  const roleKey = chatRoleKey(record, teams, runs)
  const role = ROLE_LABELS[roleKey]
  const providerLabel = agentProviderLabel(record)
  const preset = record?.metadata.name
  // A preset named after its provider adds nothing beside the provider label.
  const distinct = preset && preset.toLowerCase() !== providerLabel?.toLowerCase()
  const detail = [providerLabel, distinct ? preset : undefined].filter(Boolean).join(' · ')
  return { role, roleKey, detail, title: detail ? `${role} · ${detail}` : role }
}

export function useChatIdentity(record: SessionRecord | undefined) {
  const teams = useChatTeams((s) => s.teams[record?.metadata.projectId ?? ''])
  const runs = useChatTeams((s) => s.runs[record?.metadata.projectId ?? ''])
  return chatIdentity(record, teams, runs)
}
