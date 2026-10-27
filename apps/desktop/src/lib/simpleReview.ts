import { useStore } from '../store'
import {
  REVIEW_SCOPE,
  type DeviceManifest,
  type Project,
  type ReviewRequest,
  type Worktree,
} from '../types'
import { terminalSnapshot } from './ipc'
import { stopAndWait } from './stopAndWait'
import { reviewWorktreeBusy, startReviewAgents } from './reviewAgents'
import { hydrateReplies } from './simpleReplies'
import { hydrateActivity } from './activity'

export function simpleReviewRequest(
  source: Pick<Worktree, 'path' | 'branch'> | undefined,
  base: string | null | undefined,
): ReviewRequest {
  if (!source) throw new Error('Wait for the worktree to load before starting a review.')
  if (!source.branch)
    throw new Error('Check out a branch before starting a review. HEAD is detached.')
  if (!base) throw new Error('Choose a review base in Options before starting a review.')
  return { worktree: source.path, branch: source.branch, base }
}

/** Reuse review slots only after their previous turns have settled. */
export async function startSimpleReview(
  project: Project,
  request: ReviewRequest,
  devices: DeviceManifest[],
) {
  if (!devices.length) throw new Error('Choose at least one agent')
  const initial = useStore.getState()
  const task = initial.activeTask
  const current = () => {
    const s = useStore.getState()
    if (s.project?.id !== project.projectId || s.activeTask !== task)
      throw new Error('The worktree changed. Choose Review in the intended chat.')
    return s
  }
  const records = initial.sessionRecords.filter(
    (r) =>
      r.metadata.projectId === project.projectId &&
      r.metadata.componentId === REVIEW_SCOPE &&
      r.spec.cwd === request.worktree,
  )
  if (reviewWorktreeBusy(records, initial.sessions, request.worktree))
    throw new Error('Wait for the current review to finish before reviewing again.')
  for (const record of records) {
    // A single review uses the shared slot; parallel reviews use one slot per preset.
    const lane = record.metadata.lane ?? null
    if (
      devices.length === 1 ? lane !== (request.lane || null) : !devices.some((d) => d.id === lane)
    )
      continue
    current()
    const previous = initial.sessions[record.id] ?? record.snapshot
    const snapshot = await terminalSnapshot(record.id, 0)
    if (!snapshot?.running) continue
    const agent = snapshot.status.agent
    if (
      snapshot.generation !== previous?.generation ||
      !(
        agent?.state === 'review' ||
        agent?.state === 'ended' ||
        (agent?.state === 'idle' && agent.authoritative)
      )
    )
      throw new Error(
        'The reviewer started another turn. Wait for it to finish before reviewing again.',
      )
    current()
    await stopAndWait(
      record.id,
      'The previous reviewer is still stopping. Try Review again.',
      () => {
        current()
        return true
      },
    )
  }
  current()
  const result = await startReviewAgents(project, request, devices)
  // Reconciliation can fail after a successful launch. Never log that launch using the
  // settled generation still in the store, or startup idle will look like a finished review.
  await Promise.all(
    result.started.map(async ({ sessionId }) => {
      const snapshot = await terminalSnapshot(sessionId, 0).catch(() => null)
      const known = useStore.getState().sessions[sessionId]
      const previous =
        initial.sessions[sessionId] ?? records.find((r) => r.id === sessionId)?.snapshot
      if (snapshot && (snapshot.generation ?? 0) > (known?.generation ?? 0)) {
        useStore.getState().setSession(sessionId, {
          generation: snapshot.generation,
          running: snapshot.running,
          startedMs: snapshot.startedMs,
          status: snapshot.status,
          truncated: snapshot.truncated,
          replies: hydrateReplies(known, snapshot.generation, snapshot.replies),
          activity: hydrateActivity(known, snapshot.generation, snapshot.activity),
          exitCode: snapshot.exitCode ?? undefined,
          exitedMs: snapshot.exitedMs ?? undefined,
          notice: snapshot.notice ?? undefined,
        })
      } else if (!snapshot && known?.generation === previous?.generation) {
        useStore.getState().setSession(sessionId, { running: true })
      }
    }),
  )
  return result
}
