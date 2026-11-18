import { useStore } from '../store'
import { PLAN_SCOPE, REVIEW_SCOPE, plannerChatTask } from '../types'
import { roleDevice } from './agentRoles'
import { controlTeam, type ChatTeam } from './chatTeams'
import { terminalSnapshot } from './ipc'
import { implementPlannerPlan, type HandoffTarget } from './planHandoff'
import { agentTurnEnded } from './review'
import { fixReviewFindings } from './reviewHandoff'
import { reviewAgentRecords, reviewWorktreeBusy } from './reviewAgents'
import { sessionTimeMs } from './sessionList'
import { logStageLaunch } from './stageLog'

type Workflow = NonNullable<ChatTeam['requests']>[number]
/** A running stage request's saved result: the agent whose finish settles it. */
interface StageRun {
  sessionId: string
  startedMs: number
}

// The lead's requests run in the background, so each stage names the team's worktree rather than
// the one on screen, and launches under the team that owns it.
const target = (team: ChatTeam): HandoffTarget => ({
  projectId: team.projectId,
  task: team.task,
  chatTeam: team.id,
})
const stageName = (request: Workflow) => (request.action === 'startBuild' ? 'Build' : 'Fix')

async function startLeadBuild(team: ChatTeam) {
  const { sessionRecords, devices, agentRoles } = useStore.getState()
  const planner =
    sessionRecords
      .filter(
        (r) =>
          r.metadata.projectId === team.projectId &&
          r.metadata.componentId === PLAN_SCOPE &&
          !!r.metadata.task &&
          plannerChatTask(r.metadata.task) === team.task,
      )
      .sort((a, b) => (sessionTimeMs(b) ?? 0) - (sessionTimeMs(a) ?? 0))[0]?.metadata.terminalId ??
    roleDevice(devices, agentRoles, 'plan')?.id
  if (!planner) throw new Error('Choose an agent for the plan role first')
  const launched = await implementPlannerPlan(planner, undefined, undefined, 'stay', target(team))
  await logStageLaunch(team.projectId, team.task, 'implement', 'build', launched)
  return launched
}

async function startLeadFix(team: ChatTeam) {
  const { sessionRecords, sessions } = useStore.getState()
  if (reviewWorktreeBusy(sessionRecords, sessions, team.target))
    throw new Error('Wait for the current review to finish before fixing its findings')
  const reviewer = reviewAgentRecords(sessionRecords, team.projectId).find(
    (r) => r.metadata.componentId === REVIEW_SCOPE && r.spec.cwd === team.target,
  )
  if (!reviewer) throw new Error('Review this worktree before fixing its findings')
  const launched = await fixReviewFindings(reviewer, undefined, undefined, 'stay', target(team))
  await logStageLaunch(team.projectId, team.task, 'fix', 'build', launched)
  return launched
}

/** Launch a claimed stage. It stays active until `settleLeadStage` sees its agent finish. */
export async function startLeadStage(team: ChatTeam, request: Workflow) {
  const startedMs = Date.now()
  const launched = await (request.action === 'startBuild' ? startLeadBuild : startLeadFix)(team)
  // The workflow result wakes the lead, so the agent's own finish stays passive.
  await controlTeam(team, {
    kind: 'note',
    id: launched.requestId ?? crypto.randomUUID(),
    text: `${stageName(request)} agent for workflow ${request.id} started. Its result arrives with that workflow.`,
    sessions: [launched.sessionId],
  }).catch(() => {})
  const run: StageRun = { sessionId: launched.sessionId, startedMs }
  await controlTeam(team, {
    kind: 'requestState',
    id: request.id,
    state: 'running',
    result: JSON.stringify(run),
  })
}

function savedStage(request: Workflow): StageRun | null {
  try {
    const run = JSON.parse(request.result ?? '') as Partial<StageRun>
    return typeof run.sessionId === 'string' && typeof run.startedMs === 'number'
      ? (run as StageRun)
      : null
  } catch {
    return null
  }
}

/** Report a running stage once its agent ended a turn, exited or no longer exists. */
export async function settleLeadStage(team: ChatTeam, request: Workflow) {
  const run = savedStage(request)
  const name = stageName(request)
  const finish = (state: 'completed' | 'failed', result: string) =>
    controlTeam(team, { kind: 'requestState', id: request.id, state, result })
  if (!run) return finish('failed', `${name} agent can no longer be tracked. Inspect the worktree.`)
  const { sessions, sessionRecords } = useStore.getState()
  const live =
    sessions[run.sessionId] ?? sessionRecords.find((r) => r.id === run.sessionId)?.snapshot
  const inspect = 'Inspect its results and validation before treating the work as complete.'
  if (agentTurnEnded(live, run.startedMs))
    return finish('completed', `${name} agent reached a ready prompt. ${inspect}`)
  if (live?.running === false) return finish('completed', `${name} agent exited. ${inspect}`)
  if (!live && !(await terminalSnapshot(run.sessionId, 0).catch(() => true)))
    return finish('failed', `${name} agent's session no longer exists. Inspect the worktree.`)
}
