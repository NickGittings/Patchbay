import { projectOf, useStore } from '../store'
import type { MergeCleanup, MergeRequest, Project } from '../types'
import { mergeCleanup, mergeOutcome } from './ipc'
import { autoRuns } from './autoState'
import { reviewerBusy } from './review'
import { sessionLive } from './sessionList'
import { reconcileFreshSessions } from './sessions'
import { refreshTasks } from './tasks'
import { requestGitRefresh } from './git'

export interface CleanupJob {
  id: string
  projectId: string
  request: MergeRequest
  sessionId: string
  choice: MergeCleanup
  auto: boolean
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
  if (!record && !session) return false
  if (reviewerBusy(session, session?.running ?? (record ? sessionLive(record) : false)))
    return false
  if (job.auto) {
    const state = s.captureProjects()[job.projectId]?.state
    const run = state && autoRuns(state).find(({ run }) => run.sessionId === job.sessionId)?.run
    if (!run || run.status !== 'done') return false
  }
  const result = await mergeOutcome(project, job.request)
  return result === 'merged' || result === 'alreadyIntegrated'
}

export async function deleteMergedWork(job: CleanupJob) {
  try {
    const project = projectOf(job.projectId)
    if (!project) throw new Error('Project is no longer open')
    await mergeCleanup(project, job.request)
  } finally {
    await refreshTasks(job.projectId).catch(() => {})
    await reconcileFreshSessions().catch(() => {})
    await requestGitRefresh(job.projectId).catch(() => {})
  }
}
