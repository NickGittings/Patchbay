import { useStore } from '../store'
import { REVIEW_SCOPE, type DeviceManifest, type Project, type ReviewRequest } from '../types'
import { terminalSnapshot, terminalStop } from './ipc'
import { reviewWorktreeBusy, startReviewAgents } from './reviewAgents'

/** Reuse review slots only after their previous turns have settled. */
export async function startSimpleReview(
  project: Project,
  request: ReviewRequest,
  devices: DeviceManifest[],
) {
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
    current()
    const previous = initial.sessions[record.id] ?? record.snapshot
    const snapshot = await terminalSnapshot(record.id)
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
    await terminalStop(record.id)
    const deadline = Date.now() + 10000
    while ((await terminalSnapshot(record.id))?.running) {
      current()
      if (Date.now() >= deadline)
        throw new Error('The previous reviewer is still stopping. Try Review again.')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  current()
  return startReviewAgents(project, request, devices)
}
