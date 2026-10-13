import {
  MERGE_SCOPE,
  REVIEW_SCOPE,
  isReviewAgentScope,
  type ReviewRequest,
  type ReviewFindings,
  type Task,
  type DeviceManifest,
  type MergeRequest,
  type Project,
  type SessionRecord,
  type SessionState,
  type TerminalSpec,
  type Worktree,
} from '../types'
import { mergeAgentStart, reviewAgentStart } from './ipc'
import { listenForTerminals, reconcileFreshSessions } from './sessions'
import { sessionLive, sessionTimeMs } from './sessionList'

export function mergeDestinations(source: Worktree, worktrees: Worktree[]) {
  return worktrees.filter((w) => w.branch && w.path !== source.path && w.branch !== source.branch)
}

/** Only the project's open worktree is an automatic default. */
export function defaultMergeDestination(source: Worktree, worktrees: Worktree[]) {
  return mergeDestinations(source, worktrees).find((w) => w.current)?.path ?? ''
}

/** Live events take precedence over an older session-list snapshot after Stop. */
function jobRunning(
  records: SessionRecord[],
  sessions: Record<string, SessionState>,
  scope: string,
  cwd: string,
) {
  return records.some(
    (r) =>
      r.metadata.componentId === scope &&
      r.spec.cwd === cwd &&
      (sessions[r.id]?.running ?? sessionLive(r)),
  )
}

export const mergeDestinationRunning = (
  records: SessionRecord[],
  sessions: Record<string, SessionState>,
  destination: string,
) => jobRunning(records, sessions, MERGE_SCOPE, destination)

export const reviewWorktreeRunning = (
  records: SessionRecord[],
  sessions: Record<string, SessionState>,
  worktree: string,
) => jobRunning(records, sessions, REVIEW_SCOPE, worktree)

/**
 * A review of `worktree` that may still be writing findings. Interactive agents keep running at
 * their prompt once done, so a live process counts only while its agent reports work, or, without
 * a report, while it is producing output.
 */
export const reviewWorktreeBusy = (
  records: SessionRecord[],
  sessions: Record<string, SessionState>,
  worktree: string,
) =>
  records.some((r) => {
    if (r.metadata.componentId !== REVIEW_SCOPE || r.spec.cwd !== worktree) return false
    const s = sessions[r.id]
    if (!(s?.running ?? sessionLive(r))) return false
    const status = s?.status
    if (!status) return true
    return status.agent ? status.agent.state === 'working' : status.active
  })

/** Recover review and merge terminals from the session service, even after Review unmounts. */
export function reviewAgentRecords(records: SessionRecord[], projectId: string | undefined) {
  return records
    .filter((r) => r.metadata.projectId === projectId && isReviewAgentScope(r.metadata.componentId))
    .sort((a, b) => (sessionTimeMs(b) ?? 0) - (sessionTimeMs(a) ?? 0))
}

export function currentReviewAgentRecord(
  records: SessionRecord[],
  sessions: Record<string, SessionState>,
  selected: string | undefined,
) {
  return (
    records.find((r) => r.id === selected) ??
    records.find((r) => sessions[r.id]?.running ?? sessionLive(r))
  )
}

/** Subscribe before launching, and reconcile only a successful start. */
async function startJobAgent<R>(
  start: (
    project: Project,
    request: R,
    terminal: TerminalSpec,
    requestId: string,
  ) => Promise<string>,
  project: Project,
  request: R,
  device: DeviceManifest,
  requestId: string,
) {
  await listenForTerminals()
  const sid = await start(
    project,
    request,
    {
      id: device.id,
      name: device.name,
      command: device.command,
      adapter: device.adapter,
      kind: 'agent',
    },
    requestId,
  )
  await reconcileFreshSessions()
  return sid
}

export const startMergeAgent = (
  project: Project,
  request: MergeRequest,
  device: DeviceManifest,
  requestId: string,
) => startJobAgent(mergeAgentStart, project, request, device, requestId)

export const startReviewAgent = (
  project: Project,
  request: ReviewRequest,
  device: DeviceManifest,
  requestId: string,
) => startJobAgent(reviewAgentStart, project, request, device, requestId)

/** Bases a branch can be reviewed against: never the branch itself. */
export function reviewBases(
  source: Worktree,
  tasks: Task[],
  worktrees: Worktree[],
  branches: string[] = [],
) {
  return [
    ...new Set(
      [...worktrees.map((w) => w.branch), ...tasks.map((t) => t.base), ...branches].filter(
        (b): b is string => !!b && b !== source.branch,
      ),
    ),
  ]
}

/**
 * The source's task base, else the open worktree's branch, else a local `main` or
 * `master`; never the source branch.
 */
export function defaultReviewBase(
  source: Worktree,
  tasks: Task[],
  worktrees: Worktree[],
  branches: string[] = [],
) {
  const candidates = [
    tasks.find((t) => !t.missing && t.worktree === source.path)?.base,
    worktrees.find((w) => w.current)?.branch,
    ...['main', 'master'].filter((b) => branches.includes(b)),
  ]
  return candidates.find((b): b is string => !!b && b !== source.branch) ?? ''
}

export function reviewState(
  findings: ReviewFindings | null | undefined,
  source: Worktree | undefined,
): 'none' | 'current' | 'stale' {
  if (!findings) return 'none'
  if (
    !findings.reviewedHead ||
    findings.reviewedHead !== source?.head ||
    // Edits made while the agent was reviewing weren't necessarily reviewed.
    findings.editedSinceStart
  )
    return 'stale'
  return 'current'
}
