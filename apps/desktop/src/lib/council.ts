import {
  gitBranches,
  gitWorktrees,
  reviewRead,
  reviewAgentStart,
  terminalSnapshot,
  terminalStop,
} from './ipc'
import { agentTurnEnded, reviewerBusy } from './review'
import { useStore, projectOf, projectStateOf } from '../store'
import { controlTeam, requireTeamPreset, useChatTeams, type ChatTeam } from './chatTeams'
import { roleDevices } from './agentRoles'
import { agentTerminal } from './plan'
import { requireProviderAuth } from './providerAuth'
import { recordStageLaunch, refuseWhileAutoRuns } from './stageRecord'
import type { TerminalSpec, Worktree } from '../types'

export interface CouncilSettings {
  enabled: boolean
  members: string[]
  concurrency: number
}
export function councilSettings(value: unknown, reviewers: string[] = []): CouncilSettings {
  const v = (value ?? {}) as Partial<CouncilSettings>
  return {
    enabled: v.enabled === true,
    members: [
      ...new Set(
        Array.isArray(v.members)
          ? v.members.filter((id): id is string => typeof id === 'string')
          : reviewers,
      ),
    ],
    concurrency:
      Number.isInteger(v.concurrency) && v.concurrency! >= 1 && v.concurrency! <= 8
        ? v.concurrency!
        : 2,
  }
}
export interface CouncilRun {
  round: string
  branch: string
  base: string
  members: {
    preset: TerminalSpec
    requestId: string
    sessionId?: string
    /** When its launch began, so only turns of this launch count as its finish. */
    startedMs?: number
    state: 'queued' | 'launching' | 'running' | 'done' | 'failed'
    error?: string
  }[]
}
const active = new Set<string>()
const driving = new Map<string, Promise<void>>()
type Workflow = NonNullable<ChatTeam['requests']>[number]
type Member = CouncilRun['members'][number]
/** A lead's `startReview`: the regular review, with the reviewers and base Chat's button uses. */
const leadReview = (request: Workflow) => request.action === 'startReview'
/** Like `startReviewAgents`, a lone reviewer has no lane and several get one each. */
const laneOf = (run: CouncilRun, member: Member) =>
  run.members.length > 1 ? member.preset.id : null
async function leadReviewBase(
  team: ChatTeam,
  request: Workflow,
  source: Worktree,
  worktrees: Worktree[],
) {
  const branches = await gitBranches(team.projectId)
  const asked = request.settings.base
  let base = typeof asked === 'string' ? asked : ''
  if (!base) {
    const { chatReviewBase } = await import('./reviewAgents')
    const saved = await reviewRead(team.projectId, source.branch!)
    base =
      chatReviewBase(
        source,
        projectStateOf(team.projectId)?.tasks ?? [],
        worktrees,
        branches,
        saved?.base,
      ) ?? ''
  }
  if (!base || !branches.includes(base)) throw new Error('Choose an existing review base branch')
  return base
}
function leadReviewers(): TerminalSpec[] {
  const { devices, agentRoles } = useStore.getState()
  return roleDevices(devices, agentRoles, 'review').filter(Boolean).map(agentTerminal)
}
/** Show a lead's reviewer like a launched stage; only its workflow result wakes the lead. */
async function recordLeadReviewer(team: ChatTeam, request: Workflow, member: Member) {
  if (!leadReview(request) || !member.sessionId) return
  const launched = { sessionId: member.sessionId, requestId: member.requestId }
  await recordStageLaunch({
    projectId: team.projectId,
    task: team.task,
    origin: 'lead',
    action: 'review',
    launched: [launched],
  }).catch(() => {})
  await controlTeam(team, {
    kind: 'note',
    id: member.requestId,
    text: `Reviewer for workflow ${request.id} started. Its result arrives with that workflow.`,
    sessions: [member.sessionId],
  }).catch(() => {})
}
export function savedCouncil(request: Workflow): CouncilRun | null {
  try {
    if (request.councilRun) return structuredClone(request.councilRun)
    return request.result ? (JSON.parse(request.result) as CouncilRun) : null
  } catch {
    return null
  }
}
async function save(team: ChatTeam, request: Workflow, run: CouncilRun) {
  await controlTeam(team, {
    kind: 'requestState',
    id: request.id,
    state: 'running',
    result: JSON.stringify(run),
  })
}
export async function cancelCouncil(team: ChatTeam, request: Workflow) {
  await driving.get(request.id)
  const fresh =
    useChatTeams
      .getState()
      .teams[team.projectId]?.find((t) => t.id === team.id)
      ?.requests?.find((r) => r.id === request.id) ?? request
  if (['completed', 'failed'].includes(fresh.state)) return
  const run = savedCouncil(fresh)
  const noun = leadReview(fresh) ? 'Review' : 'Council'
  for (const member of run?.members ?? []) {
    if (member.sessionId && member.state === 'running') await terminalStop(member.sessionId)
  }
  if (run) {
    for (const member of run.members) {
      if (member.state !== 'done' && member.state !== 'failed') {
        member.state = 'failed'
        member.error = `${noun} cancelled; findings may be partial`
      }
    }
    await save(team, request, run)
  }
  await controlTeam(team, {
    kind: 'requestState',
    id: request.id,
    state: 'failed',
    result: `${noun} cancelled. Results are incomplete; do not treat them as clean.`,
  })
  active.delete(request.id)
}

/** Advance saved members without reissuing an uncertain launch after app restart. */
export async function driveCouncil(team: ChatTeam, request: Workflow) {
  if (driving.has(request.id)) return
  const promise = advanceCouncil(team, request)
  driving.set(request.id, promise)
  try {
    await promise
  } finally {
    driving.delete(request.id)
  }
}
async function advanceCouncil(team: ChatTeam, request: Workflow) {
  const { listenForTerminals, reconcileFreshSessions } = await import('./sessions')
  let run = savedCouncil(request)
  if (!run) {
    // A new review round waits for Auto, whose reviewers it would replace.
    refuseWhileAutoRuns(team.projectId, team.task)
    const project = projectOf(team.projectId)
    if (!project) throw new Error('Project is unavailable')
    const worktrees = await gitWorktrees(team.projectId)
    const source = worktrees.find((w) => w.path === team.target)
    if (!source?.branch)
      throw new Error(`${leadReview(request) ? 'Review' : 'Council'} requires a checked-out branch`)
    const base = leadReview(request)
      ? await leadReviewBase(team, request, source, worktrees)
      : request.settings.base
    if (typeof base !== 'string' || !base || base === source.branch)
      throw new Error('Choose a different review base branch')
    const { reviewWorktreeBusy } = await import('./reviewAgents')
    const store = useStore.getState()
    if (reviewWorktreeBusy(store.sessionRecords, store.sessions, team.target))
      throw new Error('Another review is still active in this worktree')
    const snapshot = request.council
    if (!leadReview(request) && (!snapshot?.[0].enabled || snapshot[1].length < 2))
      throw new Error('Council is disabled or has fewer than two reviewers')
    const reviewers = leadReview(request) ? leadReviewers() : snapshot![1]
    if (!reviewers.length) throw new Error('Choose an agent for the review role first')
    run = {
      round: crypto.randomUUID(),
      branch: source.branch,
      base,
      members: reviewers.map((preset) => ({
        preset,
        requestId: crypto.randomUUID(),
        state: 'queued',
      })),
    }
    active.add(request.id)
    await save(team, request, run)
  }
  const project = projectOf(team.projectId)
  if (!project) return
  const noun = leadReview(request) ? 'review' : 'council'
  // Sessions first: findings read afterwards include whatever a finished turn wrote.
  const state = useStore.getState()
  const findings = await reviewRead(team.projectId, run.branch)
  for (const member of run.members) {
    if (member.state === 'launching') {
      const recovered = state.sessionRecords.find((r) => r.requestIds?.includes(member.requestId))
      if (recovered) {
        member.sessionId = recovered.id
        member.state = 'running'
        await recordLeadReviewer(team, request, member)
      } else {
        member.state = 'failed'
        member.error = `Launch interrupted; request a new ${noun} to retry. No automatic relaunch.`
      }
    }
    if (member.state === 'queued' && !active.has(request.id)) {
      member.state = 'failed'
      member.error = `Not launched before restart; request a new ${noun} to retry.`
    }
    if (member.state !== 'running') continue
    const record = state.sessionRecords.find((r) => r.id === member.sessionId)
    const session = state.sessions[member.sessionId!]
    const lane =
      findings?.round === run.round
        ? findings.reviewers.find((r) => (r.lane ?? null) === laneOf(run, member))
        : undefined
    if (
      lane?.finished &&
      !reviewerBusy(session, session?.running ?? record?.snapshot?.running ?? true)
    ) {
      member.state = lane.verdict ? 'done' : 'failed'
      if (!lane.verdict) member.error = 'Review returned no complete verdict'
    } else if (session?.running === false || lane?.error) {
      member.state = 'failed'
      member.error = lane?.error ?? 'Reviewer exited without complete findings'
    } else if (agentTurnEnded(session ?? record?.snapshot, member.startedMs)) {
      member.state = 'failed'
      member.error = 'Reviewer stopped without complete findings for this review'
    } else if (
      !session &&
      !record &&
      !(await terminalSnapshot(member.sessionId!, 0).catch(() => true))
    ) {
      member.state = 'failed'
      member.error = 'Reviewer session no longer exists'
    }
  }
  let capacity =
    (leadReview(request) ? run.members.length : (request.council?.[0].concurrency ?? 2)) -
    run.members.filter((m) => m.state === 'running' || m.state === 'launching').length
  for (const member of run.members) {
    if (member.state !== 'queued' || team.state !== 'running' || team.recovery || capacity-- <= 0)
      continue
    member.state = 'launching'
    member.startedMs = Date.now()
    await save(team, request, run)
    try {
      // A lead review launches like Chat's Review, which doesn't need status hooks.
      if (leadReview(request))
        await requireProviderAuth({ terminal: member.preset, project, task: team.task })
      else await requireTeamPreset(member.preset, project, team.task)
      const { retireReviewSlots } = await import('./simpleReview')
      const lane = laneOf(run, member)
      await retireReviewSlots(team.projectId, team.target, [lane])
      await listenForTerminals()
      member.sessionId = await reviewAgentStart(
        project,
        {
          worktree: team.target,
          focus: typeof request.settings.focus === 'string' ? request.settings.focus : undefined,
          branch: run.branch,
          base: run.base,
          ...(lane ? { lane } : {}),
          round: run.round,
        },
        member.preset,
        member.requestId,
      )
      member.state = 'running'
      // The reviewer is running now, so a failed refresh must not report it as failed.
      await reconcileFreshSessions().catch(() => {})
      await recordLeadReviewer(team, request, member)
    } catch (error) {
      // A lost reply can hide a successful launch. Reconcile before declaring failure.
      await reconcileFreshSessions().catch(() => {})
      const recovered = useStore
        .getState()
        .sessionRecords.find((r) => r.requestIds?.includes(member.requestId))
      if (recovered) {
        member.sessionId = recovered.id
        member.state = 'running'
        await recordLeadReviewer(team, request, member)
      } else {
        member.state = 'failed'
        member.error = String(error)
      }
    }
    await save(team, request, run)
  }
  if (run.members.every((m) => m.state === 'done' || m.state === 'failed')) {
    await save(team, request, run)
    const current = await reviewRead(team.projectId, run.branch)
    const source = (await gitWorktrees(team.projectId)).find((w) => w.path === team.target)
    const complete =
      run.members.every((m) => m.state === 'done') &&
      current?.round === run.round &&
      !!current.verdict &&
      current.reviewedHead === source?.head &&
      source?.branch === run.branch &&
      !current.editedSinceStart &&
      !current.uncovered &&
      !current.truncated
    const summary = run.members
      .map((m) => `${m.preset.name}: ${m.state}${m.error ? ' — ' + m.error : ''}`)
      .join('\n')
    const heading = leadReview(request)
      ? `Review ${run.round} of ${run.branch} against ${run.base}. ${complete ? 'All reviewers completed.' : 'INCOMPLETE OR STALE: do not report a clean verdict.'}\n${summary}\nThe findings are in Review, where the user can fix or merge.`
      : `Council ${run.round} against ${run.base}. ${complete ? 'All members completed.' : 'INCOMPLETE OR STALE: do not report a clean council verdict.'}\n${summary}\nConsolidate duplicate findings with attribution and explain disagreements.`
    const text = `${heading}\n${current?.round === run.round ? current.text.slice(0, 10000) + (current.text.length > 10000 ? '\n[Findings excerpt; open Review for the full reports.]' : '') : 'Saved findings belong to another review round.'}`
    await controlTeam(team, {
      kind: 'requestState',
      id: request.id,
      state: complete ? 'completed' : 'failed',
      result: text,
    })
    active.delete(request.id)
  } else await save(team, request, run)
}
