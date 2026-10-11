import { useStore } from '../store'
import { PLAN_SCOPE, TASK_ROOT_SCOPE, sessionId } from '../types'
import { planRead, proposalApply, proposalRead, terminalStop } from './ipc'
import { plannerDevice } from './plan'
import { planDrafts, savePlanDraft } from './planDrafts'
import { startTerminal } from './sessions'
import { refreshTasks } from './tasks'

/** Accept the plan for this task and launch a fresh agent with the planner's provider. */
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
  // An edited plan takes precedence over a pending scope proposal.
  const edited = planDrafts.has(`${projectId}\n${task ?? ''}`)
  await savePlanDraft(projectId, task)
  const proposal = edited ? null : await proposalRead(projectId, task ?? undefined)
  current()
  if (proposal) {
    const ids = await proposalApply(current().toProject(), task ?? undefined, proposal)
    current().patchTask(projectId, task, {
      highlighted: ids,
      implementationComponents: ids.map((id) => ({ id, visible: true })),
    })
    await refreshTasks(projectId)
  }
  const plan = await planRead(projectId, task ?? undefined)
  if (!plan.text.trim())
    throw new Error(
      'No plan received yet. Ask the planner to finish its plan. Claude’s native plans require the Claude integration in Tools → Agent status integration.',
    )
  current()
  // End the planner before launching: approving its native dialog later must not
  // start a second implementation in the planning terminal.
  const sid = sessionId(PLAN_SCOPE, plannerId, task, projectId)
  if (current().sessions[sid]?.running) await terminalStop(sid)
  const s = current()
  // A running agent cannot receive a new startup briefing. Keep previous work
  // available and create a fresh session for this accepted plan.
  const terminalId = s.addRootTerminal(device)
  s.setView('implementation')
  await startTerminal(TASK_ROOT_SCOPE, terminalId, task, projectId, true)
}
