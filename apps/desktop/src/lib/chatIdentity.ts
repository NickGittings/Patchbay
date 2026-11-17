import { MERGE_SCOPE, PLAN_SCOPE, REVIEW_SCOPE, type SessionRecord } from '../types'
import { profileHookProvider } from './agentProfiles'
import { useChatTeams, type ChatTeam } from './chatTeams'
import type { ProviderRun } from './orchestration'

export type ChatRoleKey = 'lead' | 'builder' | 'planner' | 'reviewer' | 'merge' | 'agent'

const ROLE_LABELS: Record<ChatRoleKey, string> = {
  lead: 'Lead',
  builder: 'Builder',
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

/** Roles come from durable membership, never the workflow stage or selected terminal. */
export function chatIdentity(
  record: SessionRecord | undefined,
  teams: readonly ChatTeam[] = [],
  runs: readonly ProviderRun[] = [],
) {
  const roleKey: ChatRoleKey = teams.some((t) => t.lead.sessionId === record?.id)
    ? 'lead'
    : record &&
        (teams.some((t) => Object.hasOwn(t.scopes ?? {}, record.id)) ||
          runs.some(
            (r) =>
              teams.some((t) => t.id === r.chatTeam) &&
              r.jobs.some((j) => j.sessionId === record.id),
          ))
      ? 'builder'
      : (SCOPE_ROLES[record?.metadata.componentId ?? ''] ?? 'agent')
  const role = ROLE_LABELS[roleKey]
  const provider = record && (profileHookProvider(record.spec.command) ?? record.metadata.adapter)
  const providerLabel = provider === 'codex' ? 'Codex' : provider ? 'Claude' : undefined
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
