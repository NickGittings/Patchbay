import { gitWorktrees, reviewRead, reviewAgentStart, terminalStop } from './ipc'
import { reviewerBusy } from './review'
import { useStore, projectOf } from '../store'
import { controlTeam, requireTeamPreset, useChatTeams, type ChatTeam } from './chatTeams'
import type { TerminalSpec } from '../types'

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
    state: 'queued' | 'launching' | 'running' | 'done' | 'failed'
    error?: string
  }[]
}
const active = new Set<string>()
const driving = new Map<string, Promise<void>>()
type Workflow = NonNullable<ChatTeam['requests']>[number]
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
  for (const member of run?.members ?? []) {
    if (member.sessionId && member.state === 'running') await terminalStop(member.sessionId)
  }
  if (run) {
    for (const member of run.members) {
      if (member.state !== 'done' && member.state !== 'failed') {
        member.state = 'failed'
        member.error = 'Council cancelled; findings may be partial'
      }
    }
    await save(team, request, run)
  }
  await controlTeam(team, {
    kind: 'requestState',
    id: request.id,
    state: 'failed',
    result: 'Council cancelled. Results are incomplete; do not treat them as clean.',
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
    const project = projectOf(team.projectId)
    if (!project) throw new Error('Project is unavailable')
    const source = (await gitWorktrees(team.projectId)).find((w) => w.path === team.target)
    if (!source?.branch) throw new Error('Council requires a checked-out branch')
    const base = request.settings.base
    if (typeof base !== 'string' || !base || base === source.branch)
      throw new Error('Choose a different review base branch')
    const { reviewWorktreeBusy } = await import('./reviewAgents')
    const store = useStore.getState()
    if (reviewWorktreeBusy(store.sessionRecords, store.sessions, team.target))
      throw new Error('Another review is still active in this worktree')
    const snapshot = request.council
    if (!snapshot?.[0].enabled || snapshot[1].length < 2)
      throw new Error('Council is disabled or has fewer than two reviewers')
    run = {
      round: crypto.randomUUID(),
      branch: source.branch,
      base,
      members: snapshot[1].map((preset) => ({
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
  const findings = await reviewRead(team.projectId, run.branch)
  const state = useStore.getState()
  for (const member of run.members) {
    if (member.state === 'launching') {
      const recovered = state.sessionRecords.find((r) => r.requestIds?.includes(member.requestId))
      if (recovered) {
        member.sessionId = recovered.id
        member.state = 'running'
      } else {
        member.state = 'failed'
        member.error = 'Launch interrupted; request a new council to retry. No automatic relaunch.'
      }
    }
    if (member.state === 'queued' && !active.has(request.id)) {
      member.state = 'failed'
      member.error = 'Not launched before restart; request a new council to retry.'
    }
    if (member.state !== 'running') continue
    const record = state.sessionRecords.find((r) => r.id === member.sessionId)
    const session = state.sessions[member.sessionId!]
    const lane =
      findings?.round === run.round
        ? findings.reviewers.find((r) => r.lane === member.preset.id)
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
    }
  }
  let capacity =
    (request.council?.[0].concurrency ?? 2) -
    run.members.filter((m) => m.state === 'running' || m.state === 'launching').length
  for (const member of run.members) {
    if (member.state !== 'queued' || team.state !== 'running' || team.recovery || capacity-- <= 0)
      continue
    member.state = 'launching'
    await save(team, request, run)
    try {
      await requireTeamPreset(member.preset, project, team.task)
      const { retireReviewSlots } = await import('./simpleReview')
      await retireReviewSlots(team.projectId, team.target, [member.preset.id])
      await listenForTerminals()
      member.sessionId = await reviewAgentStart(
        project,
        {
          worktree: team.target,
          focus: typeof request.settings.focus === 'string' ? request.settings.focus : undefined,
          branch: run.branch,
          base: run.base,
          lane: member.preset.id,
          round: run.round,
        },
        member.preset,
        member.requestId,
      )
      member.state = 'running'
      await reconcileFreshSessions()
    } catch (error) {
      // A lost reply can hide a successful launch. Reconcile before declaring failure.
      await reconcileFreshSessions().catch(() => {})
      const recovered = useStore
        .getState()
        .sessionRecords.find((r) => r.requestIds?.includes(member.requestId))
      if (recovered) {
        member.sessionId = recovered.id
        member.state = 'running'
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
    const text = `Council ${run.round} against ${run.base}. ${complete ? 'All members completed.' : 'INCOMPLETE OR STALE: do not report a clean council verdict.'}\n${summary}\nConsolidate duplicate findings with attribution and explain disagreements.\n${current?.round === run.round ? current.text.slice(0, 10000) + (current.text.length > 10000 ? '\n[Findings excerpt; open Review for the full reports.]' : '') : 'Saved findings belong to another review round.'}`
    await controlTeam(team, {
      kind: 'requestState',
      id: request.id,
      state: complete ? 'completed' : 'failed',
      result: text,
    })
    active.delete(request.id)
  } else await save(team, request, run)
}
