import { projectOf, projectStateOf, useStore } from '../store'
import {
  PLAN_SCOPE,
  REVIEW_SCOPE,
  plannerChatTask,
  plannerSessionId,
  type MergeRequest,
} from '../types'
import { roleDevice } from './agentRoles'
import { controlTeam, type ChatTeam } from './chatTeams'
import { gitBranches, gitWorktrees, mergeOutcome, planRead, terminalSnapshot } from './ipc'
import { savedStage, type StageRun } from './leadStageRun'
import { implementPlannerPlan, type HandoffTarget } from './planHandoff'
import { agentTurnEnded } from './review'
import { fixReviewFindings } from './reviewHandoff'
import {
  defaultMergeDestination,
  mergeDestinationRunning,
  reviewAgentRecords,
  reviewWorktreeBusy,
  startMerge,
} from './reviewAgents'
import { sessionTimeMs } from './sessionList'
import { startTerminal } from './sessions'
import { taskOfWorktree } from './launchStage'
import {
  recordStageLaunch,
  refuseWhileAutoRuns,
  type LaunchedAgent,
  type StageAction,
} from './stageRecord'

type Workflow = NonNullable<ChatTeam['requests']>[number]
interface LaunchedStage {
  sessionId: string
  requestId?: string
  merge?: StageRun['merge']
}

// The lead's requests run in the background, so each stage names the team's worktree rather than
// the one on screen, and launches under the team that owns it.
const target = (team: ChatTeam): HandoffTarget => ({
  projectId: team.projectId,
  task: team.task,
  chatTeam: team.id,
})
const STAGE_NAMES: Record<string, string> = {
  startPlan: 'Plan',
  startBuild: 'Build',
  startFix: 'Fix',
  startMerge: 'Merge',
}
const stageName = (request: Workflow) => STAGE_NAMES[request.action]
const strings = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : undefined

// The lead's workflow tells it about its own stages, and it keeps earlier agents to investigate.
const recordLead = (
  team: ChatTeam,
  action: StageAction,
  launched: LaunchedAgent,
  request?: MergeRequest,
) =>
  recordStageLaunch({
    projectId: team.projectId,
    task: team.task,
    origin: 'lead',
    action,
    launched: [launched],
    ...(request ? { request } : {}),
  })

async function startLeadPlan(team: ChatTeam, request: Workflow): Promise<LaunchedStage> {
  const { goal, story: storyId } = request.settings
  const stories = typeof storyId === 'string' ? await import('./stories') : undefined
  const story =
    stories && typeof storyId === 'string'
      ? await stories.findStory(team.projectId, storyId)
      : undefined
  if (!story && (typeof goal !== 'string' || !goal.trim())) throw new Error('Say what to plan')
  const { sessions } = useStore.getState()
  const device = requireRoleDevice('plan')
  const sessionId = plannerSessionId(device.id, team.projectId, team.task)
  // Starting over would replace a conversation someone may still be using.
  if (sessions[sessionId]?.running)
    throw new Error('A planner is already running in this worktree. Ask the user how to proceed.')
  const components = leadComponents(team, request.settings.components)
  const requestId =
    stories && story
      ? // The same briefing and status as the board's Plan, in the team's worktree.
        await stories.launchStoryPlanner(
          team.projectId,
          team.task,
          device.id,
          story,
          components?.length
            ? components
            : stories.storyComponents(projectStateOf(team.projectId)?.stories ?? [], story),
          typeof goal === 'string' ? goal : undefined,
        )
      : await startTerminal(PLAN_SCOPE, device.id, team.task, team.projectId, {
          kickoff: { kind: 'planRequest' },
          planRequest: goal as string,
          components,
        })
  const launched = { sessionId, requestId }
  await recordLead(team, 'plan', launched)
  return launched
}

/**
 * The map components a lead named for its planner, without ones no longer on the map. None left
 * (or none named) keeps the worktree's highlighted components, or the story's.
 */
function leadComponents(team: ChatTeam, named: unknown): string[] | undefined {
  const project = projectOf(team.projectId)
  const ids = (strings(named) ?? []).filter((id) => project?.components.some((c) => c.id === id))
  return ids.length ? ids : undefined
}

async function startLeadBuild(team: ChatTeam): Promise<LaunchedStage> {
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
  await recordLead(team, 'implement', launched)
  return launched
}

async function startLeadFix(team: ChatTeam): Promise<LaunchedStage> {
  const { sessionRecords, sessions } = useStore.getState()
  if (reviewWorktreeBusy(sessionRecords, sessions, team.target))
    throw new Error('Wait for the current review to finish before fixing its findings')
  const reviewer = reviewAgentRecords(sessionRecords, team.projectId).find(
    (r) => r.metadata.componentId === REVIEW_SCOPE && r.spec.cwd === team.target,
  )
  if (!reviewer) throw new Error('Review this worktree before fixing its findings')
  const launched = await fixReviewFindings(reviewer, undefined, undefined, 'stay', target(team))
  await recordLead(team, 'fix', launched)
  return launched
}

async function startLeadMerge(team: ChatTeam, request: Workflow): Promise<LaunchedStage> {
  const project = projectOf(team.projectId)
  if (!project) throw new Error('Project is unavailable')
  const [worktrees, branches] = await Promise.all([
    gitWorktrees(team.projectId),
    gitBranches(team.projectId),
  ])
  const source = worktrees.find((w) => w.path === team.target)
  if (!source?.branch) throw new Error('This worktree has no branch to merge')
  const named = request.settings.destination
  const destination =
    typeof named === 'string' && named.trim()
      ? named.trim()
      : defaultMergeDestination(source, worktrees, branches)
  if (!destination) throw new Error('Ask the user which branch to merge into')
  // The merge agent works in the destination, which Auto may own too.
  const target = worktrees.find((w) => w.branch === destination)
  if (target) refuseWhileAutoRuns(team.projectId, taskOfWorktree(target, team.projectId))
  const { sessionRecords, sessions } = useStore.getState()
  if (target && mergeDestinationRunning(sessionRecords, sessions, target.path))
    throw new Error(
      'A merge agent is already running in this destination. Ask the user how to proceed.',
    )
  const started = await startMerge({
    project,
    source,
    destinationBranch: destination,
    beforeResolve: () => {
      refuseWhileAutoRuns(team.projectId, team.task)
      if (target) refuseWhileAutoRuns(team.projectId, taskOfWorktree(target, team.projectId))
    },
    beforeLaunch: (request) => {
      refuseWhileAutoRuns(team.projectId, team.task)
      const checkout = target?.path === request.destination ? target : { path: request.destination }
      refuseWhileAutoRuns(team.projectId, taskOfWorktree(checkout, team.projectId))
    },
    device: requireRoleDevice('merge'),
    commitSource: strings(request.settings.commitSource) ?? 'report',
  })
  if (started.kind === 'uncommitted')
    throw new Error(
      `${source.branch} has uncommitted changes. Ask the user whether the merge agent should commit them. If they agree, retry with exactly these as commitSource:\n${JSON.stringify(started.changes)}`,
    )
  if (started.kind !== 'started') throw new Error('The merge did not start')
  const { request: merge, sessionId: sid, requestId } = started
  await recordLead(team, 'merge', { sessionId: sid, requestId }, merge)
  return { sessionId: sid, requestId, merge }
}

/** The preset a role launches with; a project without agent presets has none. */
function requireRoleDevice(role: 'plan' | 'merge') {
  const { devices, agentRoles } = useStore.getState()
  const device = roleDevice(devices, agentRoles, role) as ReturnType<typeof roleDevice> | undefined
  if (!device) throw new Error(`Choose an agent for the ${role} role first`)
  return device
}

function launchStage(team: ChatTeam, request: Workflow) {
  if (request.action === 'startPlan') return startLeadPlan(team, request)
  if (request.action === 'startMerge') return startLeadMerge(team, request)
  return request.action === 'startBuild' ? startLeadBuild(team) : startLeadFix(team)
}

/** Launch a claimed stage. It stays active until `settleLeadStage` sees its agent finish. */
export async function startLeadStage(team: ChatTeam, request: Workflow) {
  // Auto's agents own the worktree while its run goes on, for the lead as for the user. Planning
  // touches no code, so it may go ahead, as it does from Chat and the Plan view.
  if (request.action !== 'startPlan') refuseWhileAutoRuns(team.projectId, team.task)
  const startedMs = Date.now()
  const launched = await launchStage(team, request)
  // The workflow result wakes the lead, so the agent's own finish stays passive.
  await controlTeam(team, {
    kind: 'note',
    id: launched.requestId ?? crypto.randomUUID(),
    text: `${stageName(request)} agent for workflow ${request.id} started. Its result arrives with that workflow.`,
    sessions: [launched.sessionId],
  }).catch(() => {})
  const run: StageRun = {
    sessionId: launched.sessionId,
    startedMs,
    ...(launched.merge ? { merge: launched.merge } : {}),
  }
  await controlTeam(team, {
    kind: 'requestState',
    id: request.id,
    state: 'running',
    result: JSON.stringify(run),
  }).catch((error) => {
    // A merge that finished the task while launching completes its request first.
    if (!String(error).includes('Request already claimed or finished')) throw error
  })
}

type Finish = (state: 'completed' | 'failed', result: string, passive?: boolean) => Promise<unknown>

async function settlePlan(team: ChatTeam, run: StageRun, finish: Finish) {
  const plan = await planRead(team.projectId, team.task ?? undefined).catch(() => null)
  return plan?.text.trim() && (plan.savedMs ?? 0) >= run.startedMs
    ? finish(
        'completed',
        'Plan saved. Read it from $PATCHBAY_PLAN_FILE and summarize it for the user. Do not build it unless asked.',
      )
    : finish(
        'failed',
        'Plan agent stopped without saving a plan. It may be waiting on a question in its terminal.',
      )
}

async function settleMerge(team: ChatTeam, run: StageRun, finish: Finish) {
  const project = projectOf(team.projectId)
  if (!project || !run.merge)
    return finish('failed', 'Merge agent stopped, but its merge can no longer be checked.')
  const outcome = await mergeOutcome(project, run.merge).catch(() => null)
  const into = run.merge.destinationBranch
  // Chat already shows a finished merge, and a lead turn would count as new work after it.
  if (outcome === 'merged' || outcome === 'alreadyIntegrated')
    return finish('completed', `${run.merge.sourceBranch} is merged into ${into}.`, true)
  return finish(
    'failed',
    outcome
      ? `Merge into ${into} did not complete (${outcome}). Tell the user.`
      : `Merge agent stopped, but the merge into ${into} could not be confirmed. Tell the user.`,
  )
}

/** Report a running stage once its agent ended a turn, exited or no longer exists. */
export async function settleLeadStage(team: ChatTeam, request: Workflow) {
  const run = savedStage(request.result)
  const name = stageName(request)
  const finish: Finish = (state, result, passive) =>
    controlTeam(team, {
      kind: 'requestState',
      id: request.id,
      state,
      result,
      ...(passive ? { passive } : {}),
    })
  if (!run) return finish('failed', `${name} agent can no longer be tracked. Inspect the worktree.`)
  const { sessions, sessionRecords } = useStore.getState()
  const live =
    sessions[run.sessionId] ?? sessionRecords.find((r) => r.id === run.sessionId)?.snapshot
  const ended = agentTurnEnded(live, run.startedMs)
  if (!ended && live?.running !== false) {
    if (!live && !(await terminalSnapshot(run.sessionId, 0).catch(() => true)))
      return finish('failed', `${name} agent's session no longer exists. Inspect the worktree.`)
    return
  }
  if (request.action === 'startPlan') return settlePlan(team, run, finish)
  if (request.action === 'startMerge') return settleMerge(team, run, finish)
  const inspect = 'Inspect its results and validation before treating the work as complete.'
  return finish(
    'completed',
    ended ? `${name} agent reached a ready prompt. ${inspect}` : `${name} agent exited. ${inspect}`,
  )
}
