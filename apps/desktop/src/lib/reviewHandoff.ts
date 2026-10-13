import { useStore } from '../store'
import { TASK_ROOT_SCOPE, type SessionRecord } from '../types'
import { reviewFixTask } from './ipc'
import { agentDevices } from './plan'
import { startTerminal } from './sessions'

/**
 * Launch a fresh implementation agent in the reviewed worktree to address its findings. The
 * backend resolves the worktree, branch and task from the review session's own record.
 */
export async function fixReviewFindings(record: SessionRecord) {
  const projectId = useStore.getState().project?.id
  if (!projectId) throw new Error('Open a project first')
  if (projectId !== record.metadata.projectId) throw new Error('Open the reviewed project first')
  const task = await reviewFixTask(record.id, projectId)
  const s = useStore.getState()
  if (s.project?.id !== projectId) throw new Error('Open the reviewed project first')
  // Session records keep the preset's command but not its id, so match the reviewer's provider.
  const agents = agentDevices(s.devices)
  const device = agents.find((d) => d.adapter === record.metadata.adapter) ?? agents[0]
  // Exact: a `null` here means no task holds the project folder, so nothing to redirect to.
  if (s.activeTask !== task) s.setActiveTask(task, true)
  const switched = useStore.getState()
  if (switched.activeTask !== task) throw new Error("Couldn't switch to the reviewed worktree")
  const id = switched.addRootTerminal(device)
  await startTerminal(TASK_ROOT_SCOPE, id, task, projectId, {
    kind: 'fixFindings',
    reviewSession: record.id,
  })
  // The agent runs either way; follow it only if the user stayed in its worktree.
  const after = useStore.getState()
  if (after.project?.id === projectId && after.activeTask === task) after.setView('implementation')
}
