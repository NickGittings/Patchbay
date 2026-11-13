import type { SessionRecord } from '../types'
import { profileHookProvider } from './agentProfiles'
import { useChatTeams, type ChatTeam } from './chatTeams'
import type { ProviderRun } from './orchestration'

/** Roles come from durable membership, never the workflow stage or selected terminal. */
export function chatIdentity(
  record: SessionRecord | undefined,
  teams: readonly ChatTeam[] = [],
  runs: readonly ProviderRun[] = [],
) {
  const role = teams.some((t) => t.lead.sessionId === record?.id)
    ? 'Lead'
    : record &&
        (teams.some((t) => Object.hasOwn(t.scopes ?? {}, record.id)) ||
          runs.some(
            (r) =>
              teams.some((t) => t.id === r.chatTeam) &&
              r.jobs.some((j) => j.sessionId === record.id),
          ))
      ? 'Builder'
      : 'Agent'
  const provider = record && (profileHookProvider(record.spec.command) ?? record.metadata.adapter)
  const providerLabel = provider === 'codex' ? 'Codex' : provider ? 'Claude' : undefined
  return {
    role,
    provider: providerLabel,
    preset: record?.metadata.name,
    label: [role, providerLabel].filter(Boolean).join(' · '),
  }
}

export function useChatIdentity(record: SessionRecord | undefined) {
  const teams = useChatTeams((s) => s.teams[record?.metadata.projectId ?? ''])
  const runs = useChatTeams((s) => s.runs[record?.metadata.projectId ?? ''])
  return chatIdentity(record, teams, runs)
}
