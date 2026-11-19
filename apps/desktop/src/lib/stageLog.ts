import type { SimpleAction, SimpleStage } from './simple'
import { logLaunch } from './simpleActions'

/** Record a started stage in its worktree's chat, whether a button or the lead started it. */
export const logStageLaunch = (
  projectId: string,
  task: string | null,
  action: SimpleAction,
  stage: SimpleStage,
  launched: { sessionId: string; requestId?: string },
  options?: { lead?: true },
) =>
  logLaunch(
    projectId,
    task,
    { kind: 'action', action, stage, sessionId: launched.sessionId, ...options },
    launched.requestId,
    { atRunStart: true },
  )
