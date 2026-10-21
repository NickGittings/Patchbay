import { useStore } from '../store'
import { TASK_ROOT_SCOPE, sessionId, type AutoBrief, type SessionRecord } from '../types'
import { reviewFixTask } from './ipc'
import { roleDevice } from './agentRoles'
import { agentDevices } from './plan'
import { startTerminal } from './sessions'
import { refreshTasks } from './tasks'

/**
 * Launch a fresh implementation agent in the reviewed worktree to address its findings. The
 * backend resolves the worktree, branch and task from the review session's own record, and refuses
 * a fix it wouldn't launch before anything here changes. Auto passes its brief and preset. Returns
 * the launched session's id.
 */
export async function fixReviewFindings(
  record: SessionRecord,
  auto?: AutoBrief,
  deviceId?: string,
  presentation: 'stay' | 'follow' = 'follow',
) {
  const projectId = useStore.getState().project?.id
  if (!projectId) throw new Error('Open a project first')
  if (projectId !== record.metadata.projectId) throw new Error('Open the reviewed project first')
  const task = await reviewFixTask(record.id, projectId)
  // The task may come from the CLI or another window, or its worktree may have come back, since
  // the list was loaded; the backend just checked it exists.
  if (task !== null && !useStore.getState().tasks.some((t) => t.id === task && !t.missing))
    await refreshTasks(projectId)
  const s = useStore.getState()
  if (s.project?.id !== projectId) throw new Error('Open the reviewed project first')
  // Auto's fix agent, else the project's fix role, else the reviewer's provider: session records
  // keep the preset's command but not its id, so match by adapter.
  const agents = agentDevices(s.devices)
  const device =
    (deviceId && agents.find((d) => d.id === deviceId)) ||
    roleDevice(
      s.devices,
      s.agentRoles,
      'fix',
      agents.find((d) => d.adapter === record.metadata.adapter),
    )
  const previous = s.activeTask
  // Exact: a `null` here means no task holds the project folder, so nothing to redirect to.
  if (previous !== task) s.setActiveTask(task, true)
  const switched = useStore.getState()
  if (switched.activeTask !== task) throw new Error("Couldn't switch to the reviewed worktree")
  const id = switched.addRootTerminal(device)
  try {
    await startTerminal(TASK_ROOT_SCOPE, id, task, projectId, {
      kickoff: { kind: 'fixFindings', reviewSession: record.id },
      auto,
    })
  } catch (e) {
    // Leave nothing behind for a fix that didn't start, unless the user moved on meanwhile.
    const failed = useStore.getState()
    if (failed.project?.id === projectId && failed.activeTask === task) {
      failed.removeTaskTerminal(TASK_ROOT_SCOPE, id)
      if (previous !== task) failed.setActiveTask(previous, true)
    }
    throw e
  }
  // The agent runs either way; follow it only if the user stayed in its worktree.
  const after = useStore.getState()
  if (after.project?.id === projectId && after.activeTask === task && presentation === 'follow')
    after.setView('implementation')
  return sessionId(TASK_ROOT_SCOPE, id, task, projectId)
}
