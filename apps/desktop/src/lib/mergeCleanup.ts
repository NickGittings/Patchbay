import { projectOf, projectStateOf, workspaceOf, useStore } from '../store'
import type { MergeCleanup, MergeRequest, Project } from '../types'
import { mergeCleanup, mergeCleanupPreview, mergeOutcome } from './ipc'
import { autoRuns } from './autoState'
import { reviewerBusy } from './review'
import { sessionLive } from './sessionList'
import { reconcileFreshSessions } from './sessions'
import { refreshTasks } from './tasks'
import { requestGitRefresh } from './git'
import { refreshMainWorktree } from './mainWorktree'

export interface CleanupJob {
  id: string
  workCycle?: string
  task?: string | null
  projectId: string
  request: MergeRequest
  sessionId: string
  choice: MergeCleanup
  auto: boolean
  /** The run's stable ownership identity, preserved across controller resumes. */
  autoOwnershipId?: string
  handled?: boolean
}

export function cleanupJobs(): CleanupJob[] {
  return (useStore.getState().workspaceSettings.mergeCleanupJobs as CleanupJob[] | undefined) ?? []
}

function jobTask(job: Pick<CleanupJob, 'projectId' | 'request' | 'task'>) {
  if (job.task !== undefined) return job.task
  const state = projectStateOf(job.projectId)
  const task = state?.tasks.find((t) => t.worktree === job.request.source)
  if (task) return task.id
  return job.request.source === state?.project?.root ? null : undefined
}
export function cleanupCurrent(job: CleanupJob) {
  if (job.handled || !cleanupJobs().some((j) => j.id === job.id && !j.handled)) return false
  const state = projectStateOf(job.projectId)
  if (!state) return false
  const task = jobTask(job)
  // Older saved jobs need the task list before an unknown source can be scoped safely.
  if (task === undefined) return false
  const workspace = workspaceOf(state, task)
  return (
    !workspace.finishingTask &&
    (workspace.workCycle ?? '') === (job.workCycle ?? '') &&
    !useStore.getState().sessionRecords.some((r) => r.id === job.sessionId && r.archived)
  )
}
/** Cancel pending cleanup at the task boundary, including polls already awaiting Git. */
export function retireTaskCleanup(projectId: string, task: string | null, cycle: string) {
  const retiring = cleanupJobs().filter(
    (j) =>
      !j.handled &&
      j.projectId === projectId &&
      jobTask(j) === task &&
      (j.workCycle ?? '') === cycle,
  )
  if (retiring.length)
    useStore.setState((s) => ({
      workspaceSettings: {
        ...s.workspaceSettings,
        mergeCleanupJobs: cleanupJobs().map((j) =>
          retiring.some((old) => old.id === j.id) ? { ...j, handled: true } : j,
        ),
      },
    }))
  return retiring
}

export function trackMergeCleanup(
  project: Project,
  request: MergeRequest,
  sessionId: string,
  id: string,
  choice: MergeCleanup,
  auto: boolean,
  autoOwnershipId?: string,
  workCycle?: string,
) {
  if (!project.projectId) return
  const state = projectStateOf(project.projectId)
  const task = state?.tasks.find((t) => t.worktree === request.source)?.id ?? null
  const workspace = state && workspaceOf(state, task)
  const record = useStore.getState().sessionRecords.find((r) => r.id === sessionId)
  const cycle = workCycle ?? (record ? (record.workCycle ?? '') : (workspace?.workCycle ?? ''))
  if (record?.archived || workspace?.finishingTask || cycle !== (workspace?.workCycle ?? '')) return
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
          task,
          workCycle: cycle,
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
  if (!cleanupCurrent(job)) return false
  const s = useStore.getState()
  const project = projectOf(job.projectId)
  if (!project) return false
  const record = s.sessionRecords.find((r) => r.id === job.sessionId)
  const session = s.sessions[job.sessionId]
  if (!record && !session) {
    // A partial restoration may already have retired the destination's merge session.
    const preview = await mergeCleanupPreview(project, job.request).catch(() => null)
    return cleanupCurrent(job) && (preview?.retry ?? false)
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
  return cleanupCurrent(job) && (result === 'merged' || result === 'alreadyIntegrated')
}

export async function deleteMergedWork(job: CleanupJob) {
  if (!cleanupCurrent(job)) throw new Error('This task cleanup was cancelled')
  try {
    const project = projectOf(job.projectId)
    if (!project) throw new Error('Project is no longer open')
    await mergeCleanup(project, job.request, job.workCycle ?? '')
  } finally {
    refreshMainWorktree(job.projectId)
    await refreshTasks(job.projectId).catch(() => {})
    await reconcileFreshSessions().catch(() => {})
    await requestGitRefresh(job.projectId).catch(() => {})
  }
}
