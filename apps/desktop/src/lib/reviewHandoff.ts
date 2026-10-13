import { useStore } from '../store'
import { TASK_ROOT_SCOPE, sessionId, type SessionRecord } from '../types'
import { gitWorktrees } from './ipc'
import { agentDevices } from './plan'
import { startTerminal } from './sessions'

/**
 * The task a review ran in: `null` for the project folder. A review runs at its
 * worktree's top folder, which can sit above a project opened in a subfolder.
 */
async function reviewedTask(projectId: string, cwd: string): Promise<string | null> {
  const matching = useStore.getState().tasks.filter((t) => t.worktree === cwd)
  const task = matching.find((t) => !t.missing)
  if (task) return task.id
  if (matching.length) throw new Error('The reviewed worktree no longer exists')
  const worktrees = await gitWorktrees(projectId)
  if (worktrees.some((w) => w.current && w.path === cwd)) return null
  throw new Error('Add this worktree as a task first')
}

/**
 * Launch a fresh implementation agent in the reviewed worktree with only its findings.
 * Returns the launched session's id.
 */
export async function fixReviewFindings(
  record: SessionRecord,
  auto?: import('../types').AutoBrief,
  deviceId?: string,
) {
  const reviewBranch = record.metadata.branch
  if (!reviewBranch) throw new Error('This review predates recorded branches; start a new review')
  const projectId = useStore.getState().project?.id
  if (!projectId) throw new Error('Open a project first')
  if (projectId !== record.metadata.projectId) throw new Error('Open the reviewed project first')
  const task = await reviewedTask(projectId, record.spec.cwd)
  const initial = useStore.getState()
  if (initial.project?.id !== projectId) throw new Error('Open the reviewed project first')
  const agents = agentDevices(initial.devices)
  if (!agents.length) throw new Error('No agent presets available')
  const device =
    agents.find((d) => (deviceId ? d.id === deviceId : d.adapter === record.metadata.adapter)) ??
    agents[0]
  if (initial.activeTask !== task) {
    // A null selection normally follows an attached task for the project folder.
    // This handoff explicitly targets the project folder's root session workspace.
    if (task === null) initial.setActiveTask(null, true)
    else initial.setActiveTask(task)
  }
  const current = () => {
    const s = useStore.getState()
    if (s.project?.id !== projectId || s.activeTask !== task)
      throw new Error('The task changed. Choose Fix in Implementation in the worktree you want.')
    return s
  }
  const id = current().addRootTerminal(device)
  await startTerminal(TASK_ROOT_SCOPE, id, task, projectId, {
    kickoff: 'fixFindings',
    auto,
    reviewBranch,
  })
  // The agent runs either way; follow it only if the user stayed in its worktree.
  const after = useStore.getState()
  if (after.project?.id === projectId && after.activeTask === task) after.setView('implementation')
  return sessionId(TASK_ROOT_SCOPE, id, task, projectId)
}
