import { projectStateOf, useStore, workspaceOf } from '../store'
import { PROJECT_DRAFT, plannerChatTask, plannerSessionId, type MergeRequest } from '../types'
import { noteLead, teamFor } from './chatTeams'
import type { SimpleOrigin, SimpleStage } from './simple'
import { logLaunch } from './simpleActions'
import { retireStageAgents } from './stageRetire'

export type StageAction = 'plan' | 'implement' | 'fix' | 'review' | 'merge'
export interface LaunchedAgent {
  sessionId: string
  requestId?: string
}

const STAGES: Record<StageAction, SimpleStage> = {
  plan: 'plan',
  implement: 'build',
  fix: 'build',
  review: 'review',
  merge: 'merge',
}
/** Launching one of these confirms the earlier stage's agents are done. */
const RETIRING = new Set<StageAction>(['fix', 'review', 'merge'])
const WHAT: Record<StageAction, string> = {
  plan: 'planning',
  implement: 'a build of the saved plan',
  fix: 'fixes for the review findings',
  review: 'a review of this worktree',
  merge: 'a merge',
}
const WHERE: Record<SimpleOrigin, string> = {
  chat: 'with Chat’s workflow buttons',
  manual: 'outside Chat',
  lead: '',
  auto: '',
}

export interface StageLaunch {
  projectId: string
  /** The worktree the stage works in, whose chat records it. */
  task: string | null
  origin: SimpleOrigin
  action: StageAction
  launched: readonly LaunchedAgent[]
  /** A merge's resolved request, which tells its outcome and retry branch. */
  request?: MergeRequest
  /** What the lead hears it as, e.g. `a review of feature`; the lead's own launches tell it. */
  what?: string
  autoRunId?: string
  /** Where the lead hears it came from, when the origin's usual wording would mislead. */
  from?: string
  /** What the chat shows beside the launch, such as a story's title. */
  text?: string
  /** When the launch happened, if known better than its run's start. */
  atMs?: number
  /** Agents another chat claims, which retiring never stops. */
  foreign?: ReadonlySet<string>
}

/**
 * Record a started stage the same way whichever flow started it: in its worktree's chat log,
 * tagged with where it came from. Chat and Review/Plan launches then retire the earlier stage's
 * finished agents and tell the worktree's lead. The lead's own launches keep their agents for it
 * to investigate and are announced by its workflow, and Auto owns its agents. Review and merge
 * agents also become the Review view's current agent.
 */
export async function recordStageLaunch(launch: StageLaunch) {
  const { projectId, task, origin, action, launched, request, autoRunId } = launch
  if (!launched.length) return
  await Promise.all(
    launched.map((agent) =>
      logLaunch(
        projectId,
        task,
        {
          kind: 'action',
          action,
          stage: STAGES[action],
          sessionId: agent.sessionId,
          origin,
          ...(autoRunId ? { autoRunId } : {}),
          ...(request ? { request } : {}),
          ...(launch.text ? { text: launch.text } : {}),
          ...(launch.atMs !== undefined ? { atMs: launch.atMs } : {}),
        },
        agent.requestId,
        // A merge's entry stays at its click; other stages sit at their run's start.
        action === 'merge' ? undefined : { atRunStart: true },
      ),
    ),
  )
  if (action === 'review' || action === 'merge')
    showReviewAgent(projectId, task, launched[0].sessionId)
  if (origin !== 'chat' && origin !== 'manual') return
  const ids = launched.map((a) => a.sessionId)
  if (RETIRING.has(action)) await retireStageAgents(projectId, task, ids, launch.foreign)
  await noteLead(
    teamFor(projectId, task),
    launch.what ?? WHAT[action],
    ids,
    launched[0].requestId,
    launch.from ?? WHERE[origin],
  )
}

/**
 * The Review view follows the newest review or merge agent of the worktree it shows, without
 * opening its dock. Launches in background worktrees leave its selection alone.
 */
function showReviewAgent(projectId: string, task: string | null, sid: string) {
  const current = useStore.getState()
  if (current.project?.id !== projectId || current.activeTask !== task) return
  useStore.setState((s) => ({
    reviewAgents: {
      ...s.reviewAgents,
      [projectId]: { sid, hidden: s.reviewAgents[projectId]?.hidden ?? true },
    },
  }))
}

/**
 * Record a planner started outside Chat's composer (the Plan view, a terminal's Start, scan
 * findings, a story's Plan), so its worktree's chat, strip and lead see planning begin like any
 * other stage. A project draft has no worktree chat. Recording never fails the start.
 */
export function recordPlannerStart(
  projectId: string | undefined,
  task: string | null | undefined,
  terminalId: string,
  requestId?: string,
  details: Pick<StageLaunch, 'text' | 'atMs'> & { origin?: 'chat' | 'manual' } = {},
) {
  const state = useStore.getState()
  const project = projectId ?? state.project?.id
  const raw = task === undefined ? state.activeTask : task
  if (!project || raw === PROJECT_DRAFT) return
  // A main-worktree planner's session task names the project folder's chat.
  const worktree = plannerChatTask(raw)
  return recordStageLaunch({
    projectId: project,
    task: worktree,
    // Where the user clicked, which callers capture before the launch's awaits.
    origin: details.origin ?? (state.simpleMode ? 'chat' : 'manual'),
    action: 'plan',
    launched: [{ sessionId: plannerSessionId(terminalId, project, worktree), requestId }],
    from: 'by starting a planner',
    text: details.text,
    atMs: details.atMs,
  }).catch(() => {})
}

const AUTO_HOLDS: Record<string, string> = {
  running: 'Auto is running this worktree',
  waitingOnYou: 'Auto is waiting on you in this worktree',
}
/**
 * Auto's agents in its worktree are its own while its run goes on, so every flow's Build, Fix,
 * Review and Merge, the lead's too, waits. A paused run hands the worktree back: Resume infers its
 * stage from whatever was done meanwhile, as its pause messages ask.
 */
export function refuseWhileAutoRuns(projectId: string, task: string | null | undefined) {
  const state = projectStateOf(projectId)
  if (!state || task === undefined) return
  const held = AUTO_HOLDS[workspaceOf(state, task).auto?.status ?? '']
  if (held) throw new Error(`${held}. Stop Auto or let it finish first.`)
}
