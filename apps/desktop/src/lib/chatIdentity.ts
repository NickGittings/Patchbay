import type { SessionRecord } from '../types'
import { profileHookProvider } from './agentProfiles'
import { useChatTeams, type ChatTeam } from './chatTeams'
import type { ProviderRun } from './orchestration'

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

/** Roles come from durable membership, never the workflow stage or selected terminal. */
export function chatRole(
  record: SessionRecord | undefined,
  teams: readonly ChatTeam[] = [],
  runs: readonly ProviderRun[] = [],
) {
  return teams.some((t) => t.lead.sessionId === record?.id)
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

export function chatIdentity(
  record: SessionRecord | undefined,
  teams: readonly ChatTeam[] = [],
  runs: readonly ProviderRun[] = [],
) {
  const role = chatRole(record, teams, runs)
  const provider = agentProviderLabel(record)
  const preset = record?.metadata.name
  const label = [role, provider].filter(Boolean).join(' · ')
  // A preset named after its provider adds nothing beside the provider label.
  const distinct = preset && preset.toLowerCase() !== provider?.toLowerCase()
  return { role, title: distinct ? `${label} · ${preset}` : label }
}

export function useChatIdentity(record: SessionRecord | undefined) {
  const teams = useChatTeams((s) => s.teams[record?.metadata.projectId ?? ''])
  const runs = useChatTeams((s) => s.runs[record?.metadata.projectId ?? ''])
  return chatIdentity(record, teams, runs)
}
