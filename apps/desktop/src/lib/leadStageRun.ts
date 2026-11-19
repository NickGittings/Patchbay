import type { MergeRequest } from '../types'
import type { ChatTeam } from './chatTeams'

/** Lead requests that run one agent, tracked until that agent finishes. */
export const LEAD_STAGE_ACTIONS = ['startPlan', 'startBuild', 'startFix', 'startMerge']

/** A running stage request's saved result: the agent whose finish settles it. */
export interface StageRun {
  sessionId: string
  startedMs: number
  /** What a merge stage asked for, to check its outcome. */
  merge?: MergeRequest
}

export function savedStage(result: string | null | undefined): StageRun | null {
  try {
    const run = JSON.parse(result ?? '') as Partial<StageRun>
    return typeof run.sessionId === 'string' && typeof run.startedMs === 'number'
      ? (run as StageRun)
      : null
  } catch {
    return null
  }
}

/** The agents of the lead's running stages, whose questions Chat answers. */
export const leadStageSessions = (team: ChatTeam | undefined) =>
  (team?.requests ?? []).flatMap((request) => {
    const run =
      LEAD_STAGE_ACTIONS.includes(request.action) && request.state === 'running'
        ? savedStage(request.result)
        : null
    return run ? [run.sessionId] : []
  })
