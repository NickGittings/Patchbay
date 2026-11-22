import { useStore } from '../store'
import type { MergeRequest } from '../types'
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
  manual: 'from the Plan or Review view',
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
    WHERE[origin],
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
