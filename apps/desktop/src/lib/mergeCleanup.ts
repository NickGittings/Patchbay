import { projectOf, projectStateOf, useStore, workspaceOf } from '../store'
import type { MergeCleanup, MergeRequest, Project } from '../types'
import { mergeCleanup, mergeCleanupPreview, mergeOutcome } from './ipc'
import { autoRuns } from './autoState'
import { reviewerBusy } from './review'
import { sessionLive } from './sessionList'
import { reconcileFreshSessions } from './sessions'
import { refreshTasks } from './tasks'
import { requestGitRefresh } from './git'
import { refreshMainWorktree } from './mainWorktree'
import { clearedSimple } from './simple'

export interface CleanupJob {
  id: string
  projectId: string
  request: MergeRequest
  sessionId: string
  choice: MergeCleanup
  auto: boolean
  /** The run's stable ownership identity, preserved across controller resumes. */
  autoOwnershipId?: string
  chatCleared?: boolean
  handled?: boolean
}

export function cleanupJobs(): CleanupJob[] {
  return (useStore.getState().workspaceSettings.mergeCleanupJobs as CleanupJob[] | undefined) ?? []
}

export function trackMergeCleanup(
  project: Project,
  request: MergeRequest,
  sessionId: string,
  id: string,
  choice: MergeCleanup,
  auto: boolean,
  autoOwnershipId?: string,
) {
  if (!project.projectId) return
  useStore.setState((s) => ({
    workspaceSettings: {
      ...s.workspaceSettings,
      mergeCleanupJobs: [
        ...cleanupJobs().filter(
          (j) =>
            !j.handled &&
            !(
              j.projectId === project.projectId &&
              j.request.source === request.source &&
              j.request.destination === request.destination
            ),
        ),
        {
          id,
          projectId: project.projectId!,
          request,
          sessionId,
          choice,
          auto,
          autoOwnershipId,
        },
      ],
    },
  }))
}

export function handledCleanup(id: string) {
  useStore.setState((s) => ({
    workspaceSettings: {
      ...s.workspaceSettings,
      mergeCleanupJobs: cleanupJobs().map((j) => (j.id === id ? { ...j, handled: true } : j)),
    },
  }))
}

/** Only confirmed integration and a finished merge turn can offer cleanup. */
export async function readyCleanup(job: CleanupJob) {
  const s = useStore.getState()
  const project = projectOf(job.projectId)
  if (!project) return false
  const record = s.sessionRecords.find((r) => r.id === job.sessionId)
  const session = s.sessions[job.sessionId]
  if (!record && !session) {
    // A partial restoration may already have retired the destination's merge session.
    return (await mergeCleanupPreview(project, job.request).catch(() => null))?.retry ?? false
  }
  if (reviewerBusy(session, session?.running ?? (record ? sessionLive(record) : false)))
    return false
  if (job.auto) {
    const state = s.captureProjects()[job.projectId]?.state
    const run =
      state &&
      autoRuns(state).find(({ run }) =>
        job.autoOwnershipId
          ? (run.ownershipId ?? run.runId) === job.autoOwnershipId
          : run.sessionId === job.sessionId,
      )?.run
    if (!run || run.status !== 'done') return false
  }
  const result = await mergeOutcome(project, job.request)
  return result === 'merged' || result === 'alreadyIntegrated'
}

/** Clear the source worktree's Chat once Git and the merge agent confirm completion. */
export async function completeMergeChat(job: CleanupJob) {
  if (!(await readyCleanup(job))) return false
  // A newer merge or a dismissed prompt may have replaced this job during the Git read.
  const current = cleanupJobs().find((j) => j.id === job.id && !j.handled)
  if (!current) return false
  if (current.chatCleared || job.request.destinationBranch !== 'main') return true
  const state = projectStateOf(job.projectId)
  if (!state) return false
  const source = state.tasks.find((t) => t.worktree === job.request.source)
  if (!source && job.request.source !== state.project?.root) return false
  const task = source?.id ?? null
  const now = Date.now()
  const simple = workspaceOf(state, task).simple ?? { startedMs: now, log: [] }
  useStore.getState().patchTask(job.projectId, task, {
    simple: clearedSimple(simple, useStore.getState().sessions, now),
  })
  useStore.setState((s) => ({
    workspaceSettings: {
      ...s.workspaceSettings,
      mergeCleanupJobs: cleanupJobs().map((j) =>
        j.id === job.id ? { ...j, chatCleared: true } : j,
      ),
    },
  }))
  return true
}

export async function deleteMergedWork(job: CleanupJob) {
  try {
    const project = projectOf(job.projectId)
    if (!project) throw new Error('Project is no longer open')
    await mergeCleanup(project, job.request)
  } finally {
    refreshMainWorktree(job.projectId)
    await refreshTasks(job.projectId).catch(() => {})
    await reconcileFreshSessions().catch(() => {})
    await requestGitRefresh(job.projectId).catch(() => {})
  }
}
