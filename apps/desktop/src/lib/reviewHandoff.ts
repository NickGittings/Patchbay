import { useStore } from '../store'
import { TASK_ROOT_SCOPE, type DeviceManifest, type SessionRecord } from '../types'
import { gitWorktrees } from './ipc'
import { agentDevices } from './plan'
import { startTerminal } from './sessions'

/**
 * The task a review ran in: `null` for the project folder. A review runs at its
 * worktree's top folder, which can sit above a project opened in a subfolder.
 */
async function reviewedTask(cwd: string): Promise<string | null> {
  const matching = useStore.getState().tasks.filter((t) => t.worktree === cwd)
  const task = matching.find((t) => !t.missing)
  if (task) return task.id
  if (matching.length) throw new Error('The reviewed worktree no longer exists')
  const worktrees = await gitWorktrees()
  if (worktrees.some((w) => w.current && w.path === cwd)) return null
  throw new Error('Add this worktree as a task first')
}

/**
 * The reviewer's own preset: the longest command its launch extended (briefing flags are appended
 * to the preset's command), else one of its provider, else the first agent.
 */
export function reviewerDevice(agents: DeviceManifest[], record: SessionRecord) {
  const launched = record.spec.command.trim()
  const own = agents
    .filter((d) => {
      const command = d.command.trim()
      return !!command && (launched === command || launched.startsWith(`${command} `))
    })
    .sort((a, b) => b.command.trim().length - a.command.trim().length)[0]
  return own ?? agents.find((d) => d.adapter && d.adapter === record.metadata.adapter) ?? agents[0]
}

/** Launch a fresh implementation agent in the reviewed worktree to address its findings. */
export async function fixReviewFindings(record: SessionRecord) {
  const reviewBranch = record.metadata.branch
  if (!reviewBranch) throw new Error('This review predates recorded branches; start a new review')
  const projectId = useStore.getState().project?.id
  if (!projectId) throw new Error('Open a project first')
  if (projectId !== record.metadata.projectId) throw new Error('Open the reviewed project first')
  const task = await reviewedTask(record.spec.cwd)
  const s = useStore.getState()
  if (s.project?.id !== projectId) throw new Error('Open the reviewed project first')
  const device = reviewerDevice(agentDevices(s.devices), record)
  if (s.activeTask !== task) s.setActiveTask(task)
  const switched = useStore.getState()
  if (switched.activeTask !== task) throw new Error("Couldn't switch to the reviewed worktree")
  const id = switched.addRootTerminal(device)
  await startTerminal(TASK_ROOT_SCOPE, id, task, projectId, { kind: 'fixFindings', reviewBranch })
  // The agent runs either way; follow it only if the user stayed in its worktree.
  const after = useStore.getState()
  if (after.project?.id === projectId && after.activeTask === task) after.setView('implementation')
}
