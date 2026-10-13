import { useStore } from '../store'
import { TASK_ROOT_SCOPE, type SessionRecord } from '../types'
import { agentDevices } from './plan'
import { startTerminal } from './sessions'

/** Launch a fresh implementation agent in the reviewed worktree with only its findings. */
export async function fixReviewFindings(
  record: SessionRecord,
  auto?: import('../types').AutoBrief,
  deviceId?: string,
) {
  const initial = useStore.getState()
  const project = initial.project
  if (!project) throw new Error('Open a project first')
  const projectId = project.id
  if (projectId !== record.metadata.projectId) throw new Error('Open the reviewed project first')
  const task =
    record.spec.cwd === project.root
      ? null
      : initial.tasks.find((t) => t.worktree === record.spec.cwd)?.id
  if (task === undefined) throw new Error('Add this worktree as a task first')
  if (!initial.devices.some((d) => d.kind === 'agent'))
    throw new Error('No agent presets available')
  const agents = agentDevices(initial.devices)
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
  await startTerminal(TASK_ROOT_SCOPE, id, task, projectId, 'fixFindings', auto)
  current().setView('implementation')
  return current().activeSession!
}
