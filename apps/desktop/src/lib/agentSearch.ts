import { projectStateOf, useStore } from '../store'
import { PROJECT_DRAFT, isReservedScope, plannerChatTask, type SessionRecord } from '../types'
import { sessionOwner, terminalChatDestination } from './attention'
import { agentProviderLabel, chatRole } from './chatIdentity'
import { useChatTeams } from './chatTeams'
import { sessionIdentity } from './notifications'
import {
  distinctLabels,
  sessionLive,
  sessionRole,
  sessionTimeMs,
  worktreeLabel,
} from './sessionList'
import { reconnectSession, sessionDestinationAvailable } from './sessionNavigation'
import { shortTitle } from './shortTitle'

type Snapshot = ReturnType<typeof useStore.getState>

export interface AgentSearchResult {
  record: SessionRecord
  /** Role, component, terminal name and provider, each once. */
  title: string
  /** Project, worktree and branch. */
  detail: string
  /** Whether the query names this agent of the open project, so Enter should go to it. */
  named: boolean
}

/** Running agents of every project and worktree, in record order. */
export function liveAgentIds(s: Pick<Snapshot, 'sessionRecords' | 'sessions'>): string[] {
  return s.sessionRecords
    .filter((r) => r.metadata.kind === 'agent' && (s.sessions[r.id]?.running ?? sessionLive(r)))
    .map((r) => r.id)
}

/** The store values results are built from, apart from live state, which `liveAgentIds` covers. */
export function agentSearchInputs(s: Snapshot): unknown[] {
  return [
    s.sessionRecords,
    s.project,
    s.projects,
    s.activeTask,
    s.tasks,
    s.nodes,
    s.rootTerminals,
    s.taskWorkspaces,
    s.simple,
    s.simpleMode,
    s.runtimeTerminals,
    s.devices,
  ]
}

/** Chat membership names an agent best; any other implementing agent counts as a builder. */
function roleLabel(record: SessionRecord) {
  const { teams, runs } = useChatTeams.getState()
  const { projectId } = record.metadata
  const chat = chatRole(record, teams[projectId], runs[projectId])
  // A plain chat agent reads as an Agent here too, not its scope's Build.
  if (chat !== 'Agent' || record.spec.purpose === 'chat') return chat
  return sessionRole(record.metadata).role
}

function describe(s: Snapshot, record: SessionRecord) {
  const { metadata } = record
  const identity = sessionIdentity(s, record.id, record)
  const state = projectStateOf(metadata.projectId, s)
  const launched = identity.task === PROJECT_DRAFT ? PROJECT_DRAFT : plannerChatTask(identity.task)
  // Where opening it goes: Chat can own an agent in a different worktree from its launch folder.
  const chat = state?.project ? terminalChatDestination(record, { ...s, ...state }) : null
  const task = chat ? chat.task : launched
  const known = state?.tasks.find((t) => t.id === task)
  const ownTask = task === launched
  const taskTitle = known?.title ?? (ownTask ? identity.taskTitle : undefined)
  const component = isReservedScope(metadata.componentId)
    ? undefined
    : sessionOwner(metadata.componentId, state?.nodes ?? [])
  const role = roleLabel(record)
  const terminal = identity.terminalName ?? identity.lane
  const provider = agentProviderLabel(record)
  const generic = [component, provider].map((label) => label?.toLowerCase())
  return {
    task,
    title: distinctLabels([role, component, terminal, provider]).join(' · '),
    /** What identifies this agent, unlike a component or provider it shares with file names. */
    names: distinctLabels([role, terminal])
      .map((label) => label.toLowerCase())
      .filter((label) => !generic.includes(label)),
    detail: distinctLabels([
      identity.projectName ?? metadata.projectName,
      worktreeLabel(task, taskTitle && shortTitle(taskTitle), metadata.projectRoot),
      known?.branch ?? (ownTask ? metadata.branch : undefined),
    ]).join(' · '),
  }
}

/** Every word is a whole word of the title, and together they include one of the agent's names. */
function namesAgent(words: string[], title: string, names: string[]) {
  const titleWords = new Set(title.toLowerCase().split(/[\s·]+/))
  const typed = ` ${words.join(' ')} `
  return (
    words.every((word) => titleWords.has(word)) && names.some((name) => typed.includes(` ${name} `))
  )
}

/**
 * The running agents matching every word of `query`, nearest first: the open worktree, the open
 * project, then other projects, newest first within each. Agents that can't be shown from an open
 * project tab are left out.
 */
export function agentSearchResults(
  s: Snapshot,
  query: string,
  ids: readonly string[],
): AgentSearchResult[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const live = new Set(ids)
  return s.sessionRecords
    .filter((record) => live.has(record.id))
    .flatMap((record) => {
      const { task, title, names, detail } = describe(s, record)
      // The session's own role stays searchable when the title shows a broader one.
      const text = `${title} ${sessionRole(record.metadata).role} ${detail}`.toLowerCase()
      // Checked last, since it is the costly part and most agents don't match.
      if (!words.every((word) => text.includes(word)) || !sessionDestinationAvailable(record))
        return []
      const here = record.metadata.projectId === s.project?.id
      return [
        {
          result: { record, title, detail, named: here && namesAgent(words, title, names) },
          rank: here ? (task === s.activeTask ? 0 : 1) : 2,
          time: sessionTimeMs(record) ?? -Infinity,
        },
      ]
    })
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (b.time === a.time ? 0 : b.time > a.time ? 1 : -1) ||
        a.result.title.localeCompare(b.result.title),
    )
    .map(({ result }) => result)
}

/** Go to the agent's project, worktree and terminal; says why when it no longer can. */
export async function openAgentResult(record: SessionRecord): Promise<boolean> {
  const outcome = await reconnectSession(record)
  if (outcome === 'revealed') return true
  useStore
    .getState()
    .setMessage(
      outcome === 'ended'
        ? `${record.metadata.name} is no longer running.`
        : `${record.metadata.name}'s project or worktree is no longer available.`,
      undefined,
      undefined,
      'error',
    )
  return false
}
