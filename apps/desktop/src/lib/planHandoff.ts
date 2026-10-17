import { useStore } from '../store'
import { TASK_ROOT_SCOPE, plannerSessionId, sessionId } from '../types'
import { planRead, planWrite, proposalApply, proposalRead, terminalStop } from './ipc'
import { roleDevice } from './agentRoles'
import { agentDevices, plannerDevice } from './plan'
import { savePlanDraft } from './planDrafts'
import { startTerminal } from './sessions'
import { refreshTasks } from './tasks'

/**
 * Accept the project's plan into the active worktree and launch a fresh agent there: `deviceId`
 * (Auto's implement agent), else the project's implement role, else the planner's provider. The
 * planner belongs to the project, so the plan may have been written before the worktree existed.
 */
async function handoffPlannerPlan(
  plannerId: string,
  auto?: import('../types').AutoBrief,
  deviceId?: string,
) {
  const initial = useStore.getState()
  const projectId = initial.project?.id
  if (!projectId) throw new Error('Open a project first')
  const task = initial.activeTask
  const device =
    (deviceId && agentDevices(initial.devices).find((d) => d.id === deviceId)) ||
    roleDevice(
      initial.devices,
      initial.agentRoles,
      'implement',
      plannerDevice(initial.devices, plannerId),
    )
  const current = () => {
    const s = useStore.getState()
    if (s.project?.id !== projectId || s.activeTask !== task)
      throw new Error('The task changed. Choose Implement in the task you want to work on.')
    return s
  }
  await savePlanDraft(projectId, null)
  const proposal = await proposalRead(projectId)
  current()
  if (proposal) {
    const ids = await proposalApply(current().toProject(), undefined, proposal, task ?? undefined)
    current().patchTask(projectId, task, {
      highlighted: ids,
      implementationComponents: ids.map((id) => ({ id, visible: true })),
    })
    await refreshTasks(projectId)
  } else if (task) {
    // Carry the planner's plan into the worktree, where its agents read it.
    // An empty project plan fails even when the worktree kept an older one.
    const { text, cut } = await planRead(projectId)
    if (cut) throw new Error('The plan is longer than 64 KiB; shorten it before implementing.')
    if (!text.trim()) throw new Error('No plan received yet. Ask the planner to finish its plan.')
    await planWrite(projectId, task, text, null)
  }
  const plan = await planRead(projectId, task ?? undefined)
  if (!plan.text.trim())
    throw new Error(
      'No plan received yet. Ask the planner to finish its plan. Claude’s native plans require the Claude integration in Tools → Agent status integration.',
    )
  // The worktree holds its own plan now, so it no longer borrows the project's.
  if (task) current().patchTask(projectId, task, { plannedFromProject: false })
  // Accepting a plan ends its planner, including one Auto took over manually.
  const sid = plannerSessionId(plannerId, projectId)
  if (current().sessions[sid]?.running) await terminalStop(sid)
  const s = current()
  // A running agent cannot receive a new startup briefing. Keep previous work
  // available and create a fresh session for this accepted plan.
  const terminalId = s.addRootTerminal(device)
  await startTerminal(TASK_ROOT_SCOPE, terminalId, task, projectId, {
    kickoff: { kind: 'implementPlan' },
    auto,
  })
  // The agent is running now, so a later switch away only skips the view change; its caller
  // still learns the session it has to track.
  const after = useStore.getState()
  if (after.project?.id === projectId && after.activeTask === task) after.setView('implementation')
  return sessionId(TASK_ROOT_SCOPE, terminalId, task, projectId)
}

const handingOff = new Set<string>()
/** Serialize acceptance of a project-wide plan, including manual approvals during Auto. */
export async function implementPlannerPlan(
  plannerId: string,
  auto?: import('../types').AutoBrief,
  deviceId?: string,
) {
  const projectId = useStore.getState().project?.id
  if (!projectId) throw new Error('Open a project first')
  if (handingOff.has(projectId)) throw new Error('This plan is already being implemented')
  handingOff.add(projectId)
  try {
    return await handoffPlannerPlan(plannerId, auto, deviceId)
  } finally {
    handingOff.delete(projectId)
  }
}
