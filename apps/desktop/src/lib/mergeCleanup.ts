import { projectOf, projectStateOf, useStore, workspaceOf } from '../store'
import type { MergeCleanup, MergeRequest, Project } from '../types'
import { mergeCleanup, mergeCleanupPreview, mergeOutcome, terminalStop } from './ipc'
import { completeTeamTask, forgetTeamChat } from './chatTeams'
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
  /** When the merge was started, to tell later lead work from the merged task's. */
  startedMs?: number
  /** Handled, but the lead hasn't been told the task is complete yet. */
  contextPending?: boolean
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
            (!j.handled || j.contextPending) &&
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
          startedMs: Date.now(),
        },
      ],
    },
  }))
}

function patchCleanup(id: string, update: Partial<CleanupJob>) {
  useStore.setState((s) => ({
    workspaceSettings: {
      ...s.workspaceSettings,
      mergeCleanupJobs: cleanupJobs().map((j) => (j.id === id ? { ...j, ...update } : j)),
    },
  }))
}

export function handledCleanup(id: string) {
  patchCleanup(id, { handled: true })
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
  // Unattached Git worktrees have no Chat workspace, but still support merge cleanup.
  if (!source && job.request.source !== state.project?.root) return true
  const task = source?.id ?? null
  const now = Date.now()
  const simple = workspaceOf(state, task).simple ?? { startedMs: now, log: [] }
  useStore.getState().patchTask(job.projectId, task, {
    simple: clearedSimple(simple, useStore.getState().sessions, now),
  })
  patchCleanup(job.id, { chatCleared: true })
  return true
}

/**
 * The merge into `main` finished the task and its worktree stays: stop the merge agent and give
 * the worktree's lead a fresh conversation. False or a rejection means it should be retried.
 * After a deletion the team is already retired, so there is no lead left to replace.
 */
export async function completeTaskContext(job: CleanupJob) {
  if (job.request.destinationBranch !== 'main') return true
  const state = projectStateOf(job.projectId)
  if (!state) return false
  const source = state.tasks.find((t) => t.worktree === job.request.source)
  if (!source && job.request.source !== state.project?.root) return true
  const task = source?.id ?? null
  if (useStore.getState().sessions[job.sessionId]?.running)
    await terminalStop(job.sessionId).catch(() => {})
  await completeTeamTask(job.projectId, task, `task-done-${job.id}`, job.startedMs)
  return true
}

/** Try the lead's completion. A job left pending is retried by the cleanup poll. */
export async function settleTaskContext(job: CleanupJob) {
  if (await completeTaskContext(job).catch(() => false))
    patchCleanup(job.id, { contextPending: false })
}

/** The user's cleanup decision is final at once; the lead's fresh start never holds it up. */
export async function finishCleanup(job: CleanupJob) {
  patchCleanup(job.id, { handled: true, contextPending: true })
  await settleTaskContext(job)
}

/** The Chat of a job's source: a task, null for the project folder, undefined if it has none. */
function sourceChat(job: CleanupJob) {
  const state = projectStateOf(job.projectId)
  const source = state?.tasks.find((t) => t.worktree === job.request.source)
  if (source) return source.id
  return job.request.source === state?.project?.root ? null : undefined
}

export async function deleteMergedWork(job: CleanupJob) {
  try {
    const project = projectOf(job.projectId)
    if (!project) throw new Error('Project is no longer open')
    // Read first: the deleted worktree's task is about to disappear.
    const chat = sourceChat(job)
    await mergeCleanup(project, job.request)
    if (chat !== undefined) await forgetTeamChat(job.projectId, chat)
  } finally {
    refreshMainWorktree(job.projectId)
    await refreshTasks(job.projectId).catch(() => {})
    await reconcileFreshSessions().catch(() => {})
    await requestGitRefresh(job.projectId).catch(() => {})
  }
}
