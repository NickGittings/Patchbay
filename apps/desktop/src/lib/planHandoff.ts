import { useStore } from '../store'
import { TASK_ROOT_SCOPE, plannerSessionId } from '../types'
import { planRead, planWrite, proposalApply, proposalRead, terminalStop } from './ipc'
import { plannerDevice } from './plan'
import { savePlanDraft } from './planDrafts'
import { startTerminal } from './sessions'
import { refreshTasks } from './tasks'

/**
 * Accept the project's plan into the active worktree and launch a fresh agent there with the
 * planner's provider. The planner belongs to the project, so the plan may have been written
 * before the worktree existed.
 */
export async function implementPlannerPlan(plannerId: string) {
  const initial = useStore.getState()
  const projectId = initial.project?.id
  if (!projectId) throw new Error('Open a project first')
  const task = initial.activeTask
  const device = plannerDevice(initial.devices, plannerId)
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
  current()
  // End the planner before launching: approving its native dialog later must not
  // start a second implementation in the planning terminal.
  const sid = plannerSessionId(plannerId, projectId)
  if (current().sessions[sid]?.running) await terminalStop(sid)
  const s = current()
  // A running agent cannot receive a new startup briefing. Keep previous work
  // available and create a fresh session for this accepted plan.
  const terminalId = s.addRootTerminal(device)
  await startTerminal(TASK_ROOT_SCOPE, terminalId, task, projectId, 'implementPlan')
  current().setView('implementation')
}
