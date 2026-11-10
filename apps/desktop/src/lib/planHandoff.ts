import { requireDeviceAuth } from './providerAuth'
import { createProviderRun, providerRuns, startProviderJob } from './orchestration'
import { roleDevices } from './agentRoles'
import { updateStory } from './stories'
import { projectOf, projectStateOf, useStore, workspaceOf } from '../store'
import { TASK_ROOT_SCOPE, plannerSessionId, sessionId } from '../types'
import { planRead, proposalApply, proposalRead, terminalStop } from './ipc'
import { roleDevice } from './agentRoles'
import { agentDevices, plannerDevice } from './plan'
import { savePlanDraft } from './planDrafts'
import { startTerminal } from './sessions'
import { refreshTasks } from './tasks'

export type HandoffTarget = { projectId: string; task: string | null; providerRunId?: string }

/**
 * Accept the target worktree's own plan and assignments, then launch its implementation agent.
 * Provider order is an explicit preset, the global implement role, then its planner.
 */
async function handoffPlannerPlan(
  plannerId: string,
  auto?: import('../types').AutoBrief,
  deviceId?: string,
  presentation: 'stay' | 'follow' = 'follow',
  target?: HandoffTarget,
  workerIds?: string[],
) {
  const initial = useStore.getState()
  const projectId = target?.projectId ?? initial.project?.id
  if (!projectId) throw new Error('Open a project first')
  const state = projectStateOf(projectId)
  if (!state) throw new Error('Open a project first')
  const task = target ? target.task : initial.activeTask
  const workspace = workspaceOf(state, task)
  const story = workspace.planStoryTerminal === plannerId ? workspace.planStory : null
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
    if (!target && (s.project?.id !== projectId || s.activeTask !== task))
      throw new Error('The task changed. Choose Implement in the task you want to work on.')
    const state = projectStateOf(projectId, s)
    if (!state) throw new Error('Open the project first')
    return state
  }
  const authWorkers = workerIds
    ? agentDevices(initial.devices).filter((d) => workerIds.includes(d.id))
    : auto
      ? []
      : roleDevices(initial.devices, initial.agentRoles, 'worker')
  for (const provider of [device, ...authWorkers])
    await requireDeviceAuth(provider, projectId, task)
  current()
  await savePlanDraft(projectId, task)
  const proposal = await proposalRead(projectId, task ?? undefined)
  current()
  if (proposal) {
    const project = projectOf(projectId)
    if (!project) throw new Error('Open the project first')
    const ids = await proposalApply(project, task ?? undefined, proposal, task ?? undefined)
    current()
    useStore.getState().patchTask(projectId, task, {
      highlighted: ids,
      implementationComponents: ids.map((id) => ({ id, visible: true })),
    })
    await refreshTasks(projectId)
  }
  const plan = await planRead(projectId, task ?? undefined)
  if (!plan.text.trim())
    throw new Error(
      'No plan received yet. Ask the planner to finish its plan. Claude’s native plans require the Claude integration in Settings → Agent providers.',
    )
  // Accepting a plan ends its planner, including one Auto took over manually.
  const sid = plannerSessionId(plannerId, projectId, task)
  current()
  if (useStore.getState().sessions[sid]?.running) await terminalStop(sid)
  const s = current()
  // A running agent cannot receive a new startup briefing. Keep previous work
  // available and create a fresh session for this accepted plan.
  const workers = workerIds
    ? workerIds.map((id) => {
        const found = agentDevices(initial.devices).find((d) => d.id === id)
        if (!found) throw new Error(`Worker preset ${id} is not installed`)
        return found
      })
    : auto
      ? []
      : roleDevices(initial.devices, useStore.getState().agentRoles, 'worker')
  let launched: { sessionId: string; requestId?: string; implementationRun?: string }
  if (workers.length) {
    const project = projectOf(projectId)
    if (!project) throw new Error('Open the project first')
    const work = task === s.activeTask ? s : s.taskWorkspaces[task ?? '']
    const goal = auto?.goal ?? plan.text
    const existing = (await providerRuns(projectId)).find(
      (r) =>
        r.kind === 'implementation' &&
        r.task === task &&
        r.goal === goal &&
        (target?.providerRunId ? r.id === target.providerRunId : !auto) &&
        !['stopped', 'complete'].includes(r.state),
    )
    const run =
      existing ??
      (await createProviderRun(
        project,
        'implementation',
        goal,
        work?.highlighted ?? [],
        task,
        workers,
        device,
        target?.providerRunId,
        ...(auto?.autonomous ? [auto] : []),
      ))
    const started = run.coordinator?.sessionId
      ? run
      : await startProviderJob(project, run.id, run.coordinator!.id)
    if (!started.coordinator?.sessionId)
      throw new Error(started.error ?? 'Coordinator launch unconfirmed')
    launched = {
      sessionId: started.coordinator.sessionId,
      requestId: started.coordinator.requestId,
      implementationRun: run.id,
    }
  } else {
    const terminalId = useStore.getState().addRootTerminal(device, target)
    const requestId = await startTerminal(TASK_ROOT_SCOPE, terminalId, task, projectId, {
      kickoff: {
        kind: 'implementPlan',
        subagents: useStore.getState().implementSubagents || undefined,
      },
      auto,
    })
    launched = { sessionId: sessionId(TASK_ROOT_SCOPE, terminalId, task, projectId), requestId }
  }
  if (story && task) {
    try {
      if (current().stories.find((s) => s.id === story)?.task !== task)
        await updateStory(projectId, story, { task })
      if (
        workspaceOf(current(), task).planStory === story &&
        workspaceOf(current(), task).planStoryTerminal === plannerId
      )
        useStore.getState().patchTask(projectId, task, { planStory: null, planStoryTerminal: null })
    } catch (e) {
      useStore
        .getState()
        .setMessage(`Implementation started, but its story could not be linked: ${String(e)}`)
    }
  }
  // The agent is running now, so a later switch away only skips the view change; its caller
  // still learns the session it has to track, and the launch request that started its run.
  const after = useStore.getState()
  if (after.project?.id === projectId && after.activeTask === task && presentation === 'follow')
    after.setView('implementation')
  return launched
}

const handingOff = new Set<string>()
/** Serialize acceptance within each planning scope, including manual Auto approvals. */
export async function implementPlannerPlan(
  plannerId: string,
  auto?: import('../types').AutoBrief,
  deviceId?: string,
  presentation: 'stay' | 'follow' = 'follow',
  target?: HandoffTarget,
  workerIds?: string[],
) {
  const projectId = target?.projectId ?? useStore.getState().project?.id
  if (!projectId) throw new Error('Open a project first')
  const key = JSON.stringify([projectId, target ? target.task : useStore.getState().activeTask])
  if (handingOff.has(key)) throw new Error('This plan is already being implemented')
  handingOff.add(key)
  try {
    return await handoffPlannerPlan(plannerId, auto, deviceId, presentation, target, workerIds)
  } finally {
    handingOff.delete(key)
  }
}
