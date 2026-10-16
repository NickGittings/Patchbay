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
import { useStore } from '../store'
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
 * their prompt once done, so a live process counts as finished only once its agent reported the
 * end of its turn (`review`; a self-reported one until output resumes), or its provider's hooks
 * confirmed it idle. A permission prompt, quiet
 * thinking, a stale self-report or an unconfirmed Esc may still lead to more writing; without any
 * report, the reviewer must exit first.
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
    const agent = s?.status?.agent
    // A self-reported end of turn holds until a follow-up turn produces output again.
    if (agent?.state === 'review')
      return !agent.authoritative && (s?.status?.lastOutputMs ?? 0) > agent.sinceMs + 2000
    return !(agent?.authoritative && (agent.state === 'idle' || agent.state === 'ended'))
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
    auto?: import('../types').AutoBrief,
  ) => Promise<string>,
  project: Project,
  request: R,
  device: DeviceManifest,
  requestId: string,
  auto?: import('../types').AutoBrief,
) {
  await listenForTerminals()
  const sid = await launchJob(start, project, request, device, requestId, auto)
  await reconcileFreshSessions()
  return sid
}

function launchJob<R>(
  start: Parameters<typeof startJobAgent<R>>[0],
  project: Project,
  request: R,
  device: DeviceManifest,
  requestId: string,
  auto?: import('../types').AutoBrief,
) {
  return start(
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
    ...(auto ? [auto] : []),
  )
}

export const startMergeAgent = (
  project: Project,
  request: MergeRequest,
  device: DeviceManifest,
  requestId: string,
  auto?: import('../types').AutoBrief,
) => startJobAgent(mergeAgentStart, project, request, device, requestId, auto)

export const startReviewAgent = (
  project: Project,
  request: ReviewRequest,
  device: DeviceManifest,
  requestId: string,
  auto?: import('../types').AutoBrief,
) => startJobAgent(reviewAgentStart, project, request, device, requestId, auto)

/**
 * Start one review, or several reviewers at once, each in its own lane of one round so their
 * findings combine. Every reviewer that starts keeps running; the others' errors are returned.
 * Rejects only when none started. Each started reviewer comes with its launch request, which stays
 * the last of its record's `requestIds` until the session is launched again, and its lane (`null`
 * for a single reviewer). Every reviewer, even a single one, shares
 * `round`. The backend recovers a start whose reply was lost once the launch spawned; the
 * reconciliation after every launch settled adopts one that was still spawning then.
 */
export async function startReviewAgents(
  project: Project,
  request: ReviewRequest,
  devices: DeviceManifest[],
  auto?: import('../types').AutoBrief,
): Promise<{
  started: { sessionId: string; requestId: string; lane: string | null }[]
  round: string
  errors: string[]
}> {
  if (!devices.length) throw new Error('Choose at least one agent')
  await listenForTerminals()
  const round = crypto.randomUUID()
  const requests = devices.map(() => crypto.randomUUID())
  const results = await Promise.allSettled(
    devices.map((device, index) =>
      launchJob(
        reviewAgentStart,
        project,
        devices.length > 1 ? { ...request, lane: device.id, round } : { ...request, round },
        device,
        requests[index],
        auto,
      ),
    ),
  )
  // One reconciliation for the whole round. A temporary read failure must not discard sessions
  // that already returned successfully.
  await reconcileFreshSessions().catch(() => {})
  const records = useStore.getState().sessionRecords
  const started: { sessionId: string; requestId: string; lane: string | null }[] = []
  const errors: string[] = []
  results.forEach((result, index) => {
    const recovered =
      result.status === 'rejected'
        ? records.find((r) => r.requestIds?.includes(requests[index]))?.id
        : undefined
    if (result.status === 'fulfilled' || recovered) {
      started.push({
        sessionId: result.status === 'fulfilled' ? result.value : recovered!,
        requestId: requests[index],
        lane: devices.length > 1 ? devices[index].id : null,
      })
    } else errors.push(`${devices[index].name}: ${String(result.reason)}`)
  })
  if (!started.length) throw new Error(errors.join('\n'))
  return { started, round, errors }
}

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
