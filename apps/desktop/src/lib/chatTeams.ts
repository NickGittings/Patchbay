import { checkHooks, hooksUsable } from './agentHooks'
import { requireProviderAuth } from './providerAuth'
import { agentProvider } from './ipc'
import { profileHookProvider } from './agentProfiles'
import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { projectOf, projectStateOf, useStore, workspaceOf } from '../store'
import type { Project, SessionRecord, TerminalSpec } from '../types'
import type { ProviderRun } from './orchestration'
import { clearedSimple } from './simple'
import { logSimple } from './simpleActions'
import { selectChatAgent } from './agentChats'
import { simpleKey, useSimpleUi } from './simpleUi'

export interface TeamMessage {
  id: string
  sequence: number
  sender: string
  recipient: string
  assignment: string | null
  text: string
  state: 'pending' | 'sending' | 'delivered' | 'uncertain'
  generation: number | null
}
export interface ChatTeam {
  id: string
  projectId: string
  task: string | null
  target: string
  lead: {
    sessionId: string
    generation: number
    conversation: string | null
    preset: TerminalSpec
  }
  state: 'running' | 'paused' | 'stopped' | 'complete'
  workers: TerminalSpec[]
  limit: number
  rounds: string[]
  checkpoint: {
    goal: string
    constraints: string
    decisions: string
    remaining: string
    validation: string
  }
  messages: TeamMessage[]
  reset: {
    id: string
    nextSession: string
    phase: 'queued' | 'launching' | 'failed'
    clearHistory: boolean
    error: string | null
  } | null
  handoff: {
    startedMs?: number
    id: string
    sessionId: string
    generation: number
    text: string
    clearHistory: boolean
  } | null
  error: string | null
}
export type TeamControl =
  | { kind: 'pause' | 'resume' | 'stop' }
  | { kind: 'block'; reason: string }
  | { kind: 'retry'; assignment: string }
  | { kind: 'settings'; workers: TerminalSpec[]; limit: number }
  | { kind: 'reset'; id: string; session: string; clearHistory: boolean }
  | { kind: 'resolveDelivery'; id: string; delivered: boolean }
  | { kind: 'handoffApplied'; id: string }

export const useChatTeams = create<{
  teams: Record<string, ChatTeam[]>
  runs: Record<string, ProviderRun[]>
}>(() => ({ teams: {}, runs: {} }))
export function teamFor(projectId: string, task: string | null) {
  return useChatTeams.getState().teams[projectId]?.find((t) => t.task === task)
}
export function cacheTeam(team: ChatTeam) {
  useSimpleUi
    .getState()
    .patch(simpleKey(team.projectId, team.task), { coordinationReset: !!team.reset })
  useChatTeams.setState((s) => ({
    teams: {
      ...s.teams,
      [team.projectId]: [...(s.teams[team.projectId] ?? []).filter((t) => t.id !== team.id), team],
    },
  }))
  return team
}
export async function controlTeam(team: ChatTeam, control: TeamControl) {
  return cacheTeam(
    await invoke<ChatTeam>('chat_team_control', {
      projectId: team.projectId,
      id: team.id,
      control,
    }),
  )
}
export function leadPreset(record: SessionRecord): TerminalSpec {
  const state = useStore.getState()
  const command = record.metadata.command || record.spec.resume_command || record.spec.command
  const preset = state.devices.find(
    (d) => d.id === record.metadata.terminalId || d.command === command,
  )
  return {
    id: preset?.id ?? 'lead',
    name: preset?.name ?? record.metadata.name,
    command: preset?.command ?? command,
    kind: 'agent',
    adapter: preset?.adapter ?? record.metadata.adapter ?? undefined,
  }
}
export async function initializeTeam(
  projectId: string,
  task: string | null,
  record: SessionRecord,
  paused = false,
) {
  return cacheTeam(
    await invoke<ChatTeam>('chat_team_initialize', {
      projectId,
      seed: {
        task,
        sessionId: record.id,
        preset: leadPreset(record),
        paused,
        checkpoint: {
          goal:
            workspaceOf(projectStateOf(projectId)!, task)
              .simple?.log.filter((e) => e.kind === 'prompt')
              .at(-1)
              ?.text?.slice(0, 8000) ?? '',
          constraints: '',
          decisions: '',
          remaining:
            'Continue the user’s latest request. Inspect the worktree and durable team records.',
          validation: 'Not recorded',
        },
      },
    }),
  )
}
export async function requireTeamPreset(
  terminal: TerminalSpec,
  project: Project,
  task: string | null,
) {
  await requireProviderAuth({ terminal, project, task })
  const provider =
    profileHookProvider(terminal.command) ?? terminal.adapter ?? (await agentProvider(terminal))
  if (!provider || !hooksUsable(await checkHooks(provider)))
    throw new Error(
      `Set up Agent status integration for ${terminal.name} in Settings → Integrations. The lead can continue locally.`,
    )
}
export async function newLead(team: ChatTeam, terminal: TerminalSpec) {
  const project = projectOf(team.projectId)
  if (!project) throw new Error('Open the project before changing lead')
  await requireTeamPreset(terminal, project, team.task)
  return cacheTeam(
    await invoke<ChatTeam>('chat_team_new_lead', {
      projectId: team.projectId,
      project,
      id: team.id,
      terminal,
      requestId: crypto.randomUUID(),
    }),
  )
}
export async function resetLead(team: ChatTeam, session = team.lead.sessionId) {
  useSimpleUi.getState().patch(simpleKey(team.projectId, team.task), { coordinationReset: true })
  return controlTeam(team, {
    kind: 'reset',
    id: crypto.randomUUID(),
    session,
    clearHistory: true,
  })
}
const pendingSideMessages = new Map<string, { id: string; text: string }>()
export async function sendWorkerMessage(team: ChatTeam, assignment: string, text: string) {
  const key = JSON.stringify([team.id, assignment])
  let pending = pendingSideMessages.get(key)
  if (pending && pending.text !== text) {
    if (!team.messages.some((m) => m.id === pending!.id))
      throw new Error(
        'The previous side message is unconfirmed. Retry it or inspect the side thread before sending another message.',
      )
    pending = undefined
  }
  pending ??= { id: crypto.randomUUID(), text }
  pendingSideMessages.set(key, pending)
  const result = cacheTeam(
    await invoke<ChatTeam>('chat_team_message', {
      projectId: team.projectId,
      id: team.id,
      assignment,
      messageId: pending.id,
      text,
    }),
  )
  pendingSideMessages.delete(key)
  return result
}
/** Apply only a confirmed replacement, once, including when its worktree is in the background. */
export async function applyTeamHandoff(team: ChatTeam) {
  const handoff = team.handoff
  const state = projectStateOf(team.projectId)
  if (!handoff || !state) return
  let simple = workspaceOf(state, team.task).simple ?? { startedMs: Date.now(), log: [] }
  if (simple.coordinationHandoff !== handoff.id) {
    if (handoff.clearHistory) {
      const startedMs = handoff.startedMs || Date.now()
      const fresh = (entry: (typeof simple.log)[number]) =>
        entry.sessionId === handoff.sessionId && (entry.generation ?? -1) >= handoff.generation
      const incoming = simple.log.filter(fresh)
      const sessions = Object.fromEntries(
        Object.entries(useStore.getState().sessions).filter(
          ([sid, session]) =>
            sid !== handoff.sessionId || (session.generation ?? -1) < handoff.generation,
        ),
      )
      const cleared = clearedSimple(
        { ...simple, log: simple.log.filter((entry) => !fresh(entry)) },
        sessions,
        startedMs - 1,
      )
      simple = { ...cleared, log: incoming }
    }
    useStore.getState().patchTask(team.projectId, team.task, {
      simple: {
        ...simple,
        selectedAgent: handoff.sessionId,
        coordinationHandoff: handoff.id,
        agentRuns: [
          ...(simple.agentRuns ?? []),
          { sessionId: handoff.sessionId, generation: handoff.generation },
        ],
      },
    })
    logSimple(team.projectId, team.task, {
      kind: 'action',
      action: 'handoff',
      atMs: Math.max(handoff.startedMs || Date.now(), (simple.clearBoundary?.atMs ?? 0) + 1),
      stage: 'build',
      sessionId: handoff.sessionId,
      generation: handoff.generation,
      text: `New lead conversation. A concise work handoff is retained.\n\n${handoff.text}`,
    })
  }
  await controlTeam(team, { kind: 'handoffApplied', id: handoff.id })
}
/** Migration adopts saved recipients paused and never launches workers. */
export async function refreshChatTeams(projectId: string) {
  const saved = projectStateOf(projectId)
  if (saved) {
    const workspaces = new Map(Object.entries(saved.taskWorkspaces))
    workspaces.set(saved.activeTask ?? '', {
      ...workspaceOf(saved, saved.activeTask),
      auto: saved.auto,
    })
    await Promise.allSettled(
      [...workspaces].flatMap(([task, workspace]) =>
        workspace.auto && ['done', 'stopped'].includes(workspace.auto.status)
          ? [
              autoOwnership(
                projectId,
                task || null,
                false,
                workspace.auto.ownershipId ?? workspace.auto.runId,
              ),
            ]
          : [],
      ),
    )
  }
  const teams = await invoke<ChatTeam[]>('chat_teams', { projectId })
  useChatTeams.setState((s) => ({ teams: { ...s.teams, [projectId]: teams } }))
  for (const team of teams) {
    await applyTeamHandoff(team)
    const state = projectStateOf(projectId)
    if (
      state &&
      !team.reset &&
      workspaceOf(state, team.task).simple?.selectedAgent !== team.lead.sessionId
    )
      selectChatAgent(projectId, team.task, team.lead.sessionId)
    const key = simpleKey(projectId, team.task)
    useSimpleUi.getState().patch(key, { coordinationReset: !!team.reset })
  }
  const state = projectStateOf(projectId)
  if (!state) return
  const workspaces = new Map(Object.entries(state.taskWorkspaces))
  workspaces.set(state.activeTask ?? '', {
    ...workspaceOf(state, state.activeTask),
    simple: state.simple,
  })
  for (const [key, workspace] of workspaces) {
    const task = key || null
    if (
      !workspace.simple?.selectedAgent ||
      teams.some((t) => t.task === task) ||
      (workspace.auto && !['done', 'stopped'].includes(workspace.auto.status))
    )
      continue
    const record = useStore
      .getState()
      .sessionRecords.find((r) => r.id === workspace.simple?.selectedAgent)
    if (record) await initializeTeam(projectId, task, record, true).catch(() => {})
  }
}
export function autoOwnership(
  projectId: string,
  task: string | null,
  acquire: boolean,
  ownerId?: string,
) {
  const state = projectStateOf(projectId)
  const auto = state ? workspaceOf(state, task).auto : undefined
  const id = ownerId ?? auto?.ownershipId ?? auto?.runId
  if (!id) return Promise.resolve()
  return invoke<void>('auto_worktree_ownership', { projectId, task, id, acquire })
}
