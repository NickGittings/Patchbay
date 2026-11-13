import { planTerminals } from './plan'
import { checkHooks, hooksUsable } from './agentHooks'
import { ProviderSetupRequired, requireProviderAuth } from './providerAuth'
import { agentProvider } from './ipc'
import { profileHookProvider } from './agentProfiles'
import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { projectOf, projectStateOf, useStore, workspaceOf } from '../store'
import type { Project, SessionRecord, TerminalSpec } from '../types'
import type { ProviderRun } from './orchestration'
import { clearedSimple } from './simple'
import { logSimple } from './simpleActions'
import { claimAgentChat, selectChatAgent } from './agentChats'
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
  scopes?: Record<string, { generation: number; components: string[]; paths?: string[] }>
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
  presets?: TerminalSpec[]
  agentRoles?: Record<string, string[]>
  limit: number
  rounds: string[]
  requests?: {
    id: string
    action: string
    settings: Record<string, unknown>
    state: string
    result: string | null
  }[]
  checkpoint: {
    goal: string
    constraints: string
    decisions: string
    remaining: string
    validation: string
  }
  informationRequests?: {
    id: string
    recipient: string
    generation: number
    question: string
    response: string | null
  }[]
  recovery?: boolean
  deliveries?: { recipient: string; generation: number; readySince: number }[]
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
  | { kind: 'catalog'; presets: TerminalSpec[]; roles: Record<string, string[]> }
  | { kind: 'requestState'; id: string; state: string; result: string | null }
  | { kind: 'pause' | 'resume' | 'stop' | 'historyBoundary' }
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
/** Background coordination owns its submitted ready prompt until a later hook confirms a turn. */
export function leadDeliveryPending(
  projectId: string,
  task: string | null,
  sid: string,
  generation: number,
) {
  const team = teamFor(projectId, task)
  if (!team || team.lead.sessionId !== sid) return false
  const session = useStore.getState().sessions[sid]
  return (
    !!team.reset ||
    !!team.recovery ||
    (team.messages ?? []).some((m) => m.recipient === 'lead' && m.state !== 'delivered') ||
    (team.deliveries ?? []).some(
      (d) =>
        d.recipient === 'lead' &&
        d.generation === generation &&
        d.readySince >= (session?.status?.agent?.sinceMs ?? 0),
    )
  )
}
export type ChatFailureKind =
  'authentication' | 'access' | 'configuration' | 'connection' | 'uncertain'
export class ChatConnectionError extends Error {
  kind: ChatFailureKind
  constructor(kind: ChatFailureKind, message: string) {
    super(message)
    this.kind = kind
  }
}
export interface ChatContinuation {
  session: SessionRecord
  generation: number
  outcome: 'connected' | 'resumed' | 'reconstructed'
  team: ChatTeam
}
const continuations = new Map<string, Promise<ChatContinuation>>()
/** Resolve the same durable lead. Never infer failure classes from provider error text. */
export function continueChat(team: ChatTeam) {
  const key = simpleKey(team.projectId, team.task)
  const pending = continuations.get(key)
  if (pending) return pending
  const continuation = resolveChat(team).finally(() => {
    continuations.delete(key)
    useSimpleUi.getState().patch(key, { connection: undefined })
  })
  continuations.set(key, continuation)
  return continuation
}
export function continuationContext(projectId: string, task: string | null) {
  const state = projectStateOf(projectId)
  const simple = state && workspaceOf(state, task).simple
  return (simple?.log ?? [])
    .filter((e) => !simple?.clearBoundary || e.atMs > simple.clearBoundary.atMs)
    .filter((e) => e.kind === 'prompt' || e.kind === 'reply')
    .slice(-20)
    .map((e) => `${e.kind === 'prompt' ? 'User' : 'Lead'}: ${'text' in e ? e.text : ''}`)
    .join('\n\n')
    .slice(-16000)
}
async function resolveChat(team: ChatTeam) {
  const key = simpleKey(team.projectId, team.task)
  const project = projectOf(team.projectId)
  if (!project) throw new Error('Open the project to reconnect. Your draft was kept.')
  const { reconcileFreshSessions } = await import('./sessions')
  await reconcileFreshSessions()
  const live = useStore.getState().sessions[team.lead.sessionId]?.running
  useSimpleUi.getState().patch(key, { connection: live ? 'Connecting…' : 'Restoring context…' })
  if (!live) {
    try {
      await requireTeamPreset(team.lead.preset, project, team.task)
    } catch (error) {
      throw new ChatConnectionError(
        error instanceof ProviderSetupRequired ? 'authentication' : 'configuration',
        String(error),
      )
    }
  }
  const result = await invoke<ChatContinuation>('chat_continue', {
    projectId: team.projectId,
    project,
    id: team.id,
    savedContext: continuationContext(team.projectId, team.task),
  }).catch((error: { kind?: ChatFailureKind; message?: string }) => {
    throw new ChatConnectionError(error.kind ?? 'connection', error.message ?? String(error))
  })
  cacheTeam(result.team)
  const saved = projectStateOf(team.projectId)
  if (saved) {
    const workspace = workspaceOf(saved, team.task)
    if (!workspace.rootTerminals.some((t) => t.id === result.session.metadata.terminalId))
      useStore.getState().patchTask(team.projectId, team.task, {
        rootTerminals: [
          ...workspace.rootTerminals,
          { ...result.team.lead.preset, id: result.session.metadata.terminalId },
        ],
      })
  }
  claimAgentChat(team.projectId, team.task, result.session.id, result.generation)
  selectChatAgent(team.projectId, team.task, result.session.id)
  await applyTeamHandoff(result.team)
  await reconcileFreshSessions()
  return result
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
        'The previous message is unconfirmed. Inspect its terminal in Sessions before resolving delivery.',
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
      text: handoff.clearHistory
        ? `New lead conversation. A concise work handoff is retained.\n\n${handoff.text}`
        : 'Context restored from the saved conversation and team state.',
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
    const available = planTerminals(useStore.getState().devices).filter(
      (t) => !!(profileHookProvider(t.command) ?? t.adapter),
    )
    const roles = useStore.getState().agentRoles
    const rolesChanged = [
      ...new Set([...Object.keys(roles), ...Object.keys(team.agentRoles ?? {})]),
    ].some(
      (role) =>
        JSON.stringify(roles[role as keyof typeof roles] ?? []) !==
        JSON.stringify(team.agentRoles?.[role] ?? []),
    )
    if (
      rolesChanged ||
      (team.presets ?? []).length !== available.length ||
      available.some(
        (preset) =>
          !(team.presets ?? []).some(
            (known) =>
              known.id === preset.id &&
              known.name === preset.name &&
              known.command === preset.command &&
              known.adapter === preset.adapter,
          ),
      )
    ) {
      const updated = await controlTeam(team, { kind: 'catalog', presets: available, roles })
      team.presets = updated.presets
      team.agentRoles = updated.agentRoles
    }
    await applyTeamHandoff(team)
    await driveLeadRequests(team)
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

/** Claim durably before invoking existing workflow controls. Lost replies are never replayed. */
async function driveLeadRequests(team: ChatTeam) {
  if (team.state !== 'running' || team.reset) return
  for (const request of team.requests ?? []) {
    if (!['queued', 'waiting'].includes(request.state)) continue
    try {
      await controlTeam(team, {
        kind: 'requestState',
        id: request.id,
        state: 'starting',
        result: null,
      })
    } catch {
      continue
    }
    try {
      const auto = await import('./auto')
      if (request.action === 'startAgent') {
        const project = projectOf(team.projectId)
        if (!project) throw new Error('Project is unavailable')
        const preset = (team.presets ?? team.workers).find((w) => w.id === request.settings.preset)
        if (!preset) throw new Error('Choose a configured agent preset from team.presets')
        await requireTeamPreset(preset, project, team.task)
        await invoke('chat_team_delegate_shared', {
          projectId: team.projectId,
          project,
          id: team.id,
          requestId: request.id,
          assignments: [
            {
              id: request.id,
              preset: preset.id,
              instructions: request.settings.instructions,
              components: request.settings.components ?? [],
              paths: request.settings.paths ?? [],
              dependencies: [],
              resultKind: request.settings.resultKind ?? 'code',
            },
          ],
        })
      } else if (request.action === 'startAuto') {
        const state = projectStateOf(team.projectId)
        if (!state) throw new Error('Project is unavailable')
        const previous = workspaceOf(state, team.task).auto
        const device =
          typeof request.settings.device === 'string'
            ? request.settings.device
            : team.lead.preset.id
        const settings = {
          goal: team.checkpoint.goal,
          effort: previous?.effort ?? 'standard',
          merge: previous?.merge ?? { mode: 'ask', destinationBranch: '' },
          overrides: previous?.overrides,
          agents: previous?.agents,
          reviewers: previous?.reviewers,
          scanners: previous?.scanners,
          workers: previous?.workers,
          autonomous: previous?.autonomous,
          background: previous?.background,
          resumeOnUsageReset: previous?.resumeOnUsageReset,
          ...request.settings,
          device,
        }
        if (settings.merge.mode !== 'ask')
          throw new Error('Lead-started Auto requires merge approval')
        await auto.startAuto(team.projectId, team.task, settings as import('./auto').AutoSettings)
      } else if (request.action === 'pauseAuto') auto.pauseAuto(team.projectId, team.task)
      else if (request.action === 'resumeAuto') await auto.resumeAuto(team.projectId, team.task)
      else if (request.action === 'stopAuto') auto.stopAuto(team.projectId, team.task)
      else throw new Error('Unknown workflow action')
      await controlTeam(team, {
        kind: 'requestState',
        id: request.id,
        state: 'completed',
        result:
          request.action === 'startAgent'
            ? 'Assignment accepted; inspect team rounds for launch, coordination and completion'
            : 'Workflow control applied',
      })
    } catch (error) {
      await controlTeam(team, {
        kind: 'requestState',
        id: request.id,
        state: [
          'An unfinished provider run controls this worktree',
          'This worktree is controlled',
        ].some((reason) => String(error).includes(reason))
          ? 'waiting'
          : 'failed',
        result: String(error),
      })
    }
  }
}
