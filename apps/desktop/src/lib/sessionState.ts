import type { SessionState, TerminalSnapshot } from '../types'
import { hydrateReplies } from './simpleReplies'
import { hydrateActivity } from './activity'

/**
 * A snapshot's run as session state: every field comes from the snapshot, while replies and
 * activity merge with what this window already holds of the same run.
 */
export function sessionFromSnapshot(
  previous: SessionState | undefined,
  snapshot: TerminalSnapshot,
  interrupted: boolean | undefined,
): SessionState {
  return {
    generation: snapshot.generation,
    running: snapshot.running,
    exitCode: snapshot.exitCode ?? undefined,
    startedMs: snapshot.startedMs,
    exitedMs: snapshot.exitedMs ?? undefined,
    status: snapshot.status,
    replies: hydrateReplies(previous, snapshot.generation, snapshot.replies),
    activity: hydrateActivity(previous, snapshot.generation, snapshot.activity),
    notice: snapshot.notice ?? undefined,
    interrupted,
    truncated: snapshot.truncated,
  }
}
