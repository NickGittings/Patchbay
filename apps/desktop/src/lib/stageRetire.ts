import { projectStateOf, useStore, workspaceOf } from '../store'
import type { SessionState } from '../types'
import { teamFor } from './chatTeams'
import { terminalStop } from './ipc'
import { workflowLog, type SimpleState } from './simple'
import { awaitingTurn } from './simpleFlow'
import { simpleKey, useSimpleUi } from './simpleUi'

const STAGE_ACTIONS = new Set(['implement', 'fix', 'review'])
const AUTO_OWNS_AGENTS = new Set(['running', 'waitingOnYou', 'paused'])

export interface RetirementInput {
  simple: SimpleState | null | undefined
  sessions: Record<string, SessionState>
  /** The next stage's agents, which just started. */
  launched: readonly string[]
  foreign: ReadonlySet<string>
  leadSession?: string
  queuedSession?: string
  autoStatus?: string
}

/**
 * Earlier stage agents the next stage has replaced. Launching that stage confirms the work is
 * done, since a finished turn alone may be a question. Only a turn that ended normally counts:
 * an interrupted agent is idle, one still starting has no finished turn, and one just prompted
 * still shows the turn before.
 */
export function retirableStageAgents({
  simple,
  sessions,
  launched,
  foreign,
  leadSession,
  queuedSession,
  autoStatus,
}: RetirementInput) {
  if (autoStatus && AUTO_OWNS_AGENTS.has(autoStatus)) return []
  const retirable = new Set<string>()
  for (const entry of workflowLog(simple)) {
    if (entry.kind !== 'action' || !STAGE_ACTIONS.has(entry.action) || !entry.sessionId) continue
    const id = entry.sessionId
    const session = sessions[id]
    const agent = session?.status?.agent
    if (
      session?.running &&
      !session.disconnected &&
      session.generation === entry.generation &&
      agent?.authoritative &&
      agent.state === 'review' &&
      !agent.approvalPending &&
      !awaitingTurn(simple, id, session) &&
      !launched.includes(id) &&
      !foreign.has(id) &&
      id !== leadSession &&
      id !== queuedSession
    )
      retirable.add(id)
  }
  return [...retirable]
}

/** Stops finished agents. Their conversations stay resumable, and failures never undo a launch. */
export async function retireStageAgents(
  projectId: string,
  task: string | null,
  launched: readonly string[],
  /** Only shared planners can be another chat's, and stage entries never name one. */
  foreign: ReadonlySet<string> = new Set(),
) {
  const project = projectStateOf(projectId)
  if (!project) return
  const workspace = workspaceOf(project, task)
  const ids = retirableStageAgents({
    simple: workspace.simple,
    sessions: useStore.getState().sessions,
    launched,
    foreign,
    leadSession: teamFor(projectId, task)?.lead.sessionId,
    queuedSession: useSimpleUi.getState().worktrees[simpleKey(projectId, task)]?.queued?.sessionId,
    autoStatus: workspace.auto?.status,
  })
  await Promise.allSettled(ids.map((id) => terminalStop(id)))
}
