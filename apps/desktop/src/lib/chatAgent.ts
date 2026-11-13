import { projectStateOf, useStore, workspaceOf } from '../store'
import { TASK_ROOT_SCOPE, sessionId, type AgentRoles, type DeviceManifest } from '../types'
import { agentDevices, planTerminals } from './plan'
import { simpleKey, useSimpleUi } from './simpleUi'
import { reconcileFreshSessions, startTerminal } from './sessions'
import { initializeTeam, newLead, teamFor } from './chatTeams'
import { selectChatAgent } from './agentChats'
import { logSimple } from './simpleActions'

export function defaultChatPreset(
  devices: DeviceManifest[],
  roles: AgentRoles,
  configured: unknown,
) {
  const agents = agentDevices(devices)
  if (typeof configured === 'string' && configured) return agents.find((a) => a.id === configured)
  return agents.find((a) => a.id === roles.implement?.[0]) ?? agents[0]
}

export function chatPreset(projectId: string, task: string | null) {
  const s = useStore.getState()
  const chosen = useSimpleUi.getState().worktrees[simpleKey(projectId, task)]?.chatPreset
  return defaultChatPreset(s.devices, s.agentRoles, chosen ?? s.workspaceSettings.chatAgent)
}

const launches = new Map<string, Promise<import('../types').SessionRecord>>()
/** One startup per worktree; callers own message delivery and navigation checks. */
export function startChatAgent(projectId: string, task: string | null) {
  const key = simpleKey(projectId, task)
  const existing = launches.get(key)
  if (existing) return existing
  const launch = launchChatAgent(projectId, task).finally(() => launches.delete(key))
  launches.set(key, launch)
  return launch
}
async function launchChatAgent(projectId: string, task: string | null) {
  if (teamFor(projectId, task))
    throw new Error(
      'Reconnect the existing lead before starting another agent. Your draft was kept.',
    )
  const s = useStore.getState()
  const preset = chatPreset(projectId, task)
  if (!preset) throw new Error('Choose an available Chat agent in Settings → Agent roles.')
  const base = planTerminals(s.devices).find((t) => t.id === preset.id)!
  const terminal = { ...base, id: `chat-${crypto.randomUUID()}` }
  const project = projectStateOf(projectId)
  if (!project) throw new Error('The project is no longer available. Your draft was kept.')
  const workspace = workspaceOf(project, task)
  s.patchTask(projectId, task, { rootTerminals: [...workspace.rootTerminals, terminal] })
  await startTerminal(TASK_ROOT_SCOPE, terminal.id, task, projectId)
  await reconcileFreshSessions()
  const sid = sessionId(TASK_ROOT_SCOPE, terminal.id, task, projectId)
  const record = useStore.getState().sessionRecords.find((r) => r.id === sid)
  if (!record || !useStore.getState().sessions[sid]?.running)
    throw new Error('The agent did not start. Your draft was kept; check its terminal and retry.')
  // Keep a successfully launched session available even if coordination is unavailable.
  selectChatAgent(projectId, task, sid)
  try {
    await initializeTeam(projectId, task, record)
  } catch (error) {
    logSimple(projectId, task, {
      kind: 'action',
      action: 'selectAgent',
      stage: 'build',
      sessionId: sid,
      text: `Coordination unavailable: ${String(error)}. Continuing locally with this agent.`,
    })
  }
  logSimple(projectId, task, {
    kind: 'action',
    action: 'selectAgent',
    stage: 'build',
    sessionId: sid,
    text: `Agent: ${record.metadata.name}.`,
  })
  return record
}

export async function switchChatAgent(projectId: string, task: string | null, presetId: string) {
  const preset = planTerminals(useStore.getState().devices).find((p) => p.id === presetId)
  if (!preset) throw new Error('This agent preset is no longer available.')
  const team = teamFor(projectId, task)
  if (!team) throw new Error('Agent coordination is unavailable. Retry after reconnecting.')
  const terminal = { ...preset, id: `chat-${crypto.randomUUID()}` }
  const project = projectStateOf(projectId)
  if (!project) throw new Error('The project is no longer available. Your draft was kept.')
  const workspace = workspaceOf(project, task)
  useStore.getState().patchTask(projectId, task, {
    rootTerminals: [...workspace.rootTerminals, terminal],
  })
  await newLead(team, terminal)
}
