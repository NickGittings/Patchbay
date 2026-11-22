import type { MergeOutcome, ReviewFindings, SessionRecord, SessionState } from '../types'
import type { ChatTeam } from './chatTeams'
import { savedStage } from './leadStageRun'
import { reviewerBusy } from './review'
import {
  launchOrigin,
  workflowLog,
  recordStage,
  pendingLaunch,
  selectRecipient,
  thread,
  type SimpleSnapshot,
  type SimpleWorktree,
} from './simple'

export type SimpleStep =
  | 'idle'
  | 'planning'
  | 'planReady'
  | 'building'
  | 'built'
  | 'reviewing'
  | 'reviewed'
  | 'fixing'
  | 'fixed'
  | 'merging'
  | 'merged'
export type FlowAction =
  | 'build'
  | 'plan'
  | 'review'
  | 'fix'
  | 'checkMerge'
  | 'merge'
  | 'resumeAuto'
  | 'mergeApproval'
  | 'retryMergeStatus'
export interface StepPrompt {
  text: string
  actions: { action: FlowAction; label: string }[]
}
export interface FlowSnapshot extends SimpleSnapshot {
  worktree: SimpleWorktree
  findings?: ReviewFindings | null
  outcomePending?: boolean
  outcomeError?: string
  outcome?: MergeOutcome
  base?: string
  conflicts?: string[]
  /** The time to judge a launch's missing record against; defaults to the current time. */
  now?: number
}
export interface SimpleFlow {
  step: SimpleStep
  prompt?: StepPrompt
  /** The lead started this stage and hasn't had its say on the result yet. */
  waitingOn?: 'lead'
  busyAgent?: SessionRecord
  agent?: SessionRecord
}
const button = (action: FlowAction, label: string) => ({ action, label })

/**
 * State alone scripts the chat. No models, terminal parsing, or effects. Callers that already
 * projected the thread and chose the recipient pass them in.
 */
export function flow(
  snapshot: FlowSnapshot,
  model = thread(snapshot, snapshot.worktree),
  agent = selectRecipient(
    model.records.filter((r) => r.id !== model.lead),
    snapshot.sessions,
    model.stage,
    undefined,
    model.foreign,
  ),
): SimpleFlow {
  // A shared planner another chat is using is no agent of this conversation.
  const own = agent && !model.foreign.has(agent.id) ? agent : undefined
  const session = own ? (snapshot.sessions[own.id] ?? own.snapshot) : undefined
  const state = session?.status?.agent
  const ended =
    !own ||
    (!!session &&
      (!session.running ||
        (!awaitingTurn(snapshot.simple, own.id, session) &&
          (state?.state === 'review' ||
            state?.state === 'ended' ||
            (state?.state === 'idle' && !!state.authoritative)))))
  const working = !!own && !ended
  const auto = snapshot.auto
  // Auto's own launches are its run, not work that came after it.
  const manualAfterAuto =
    auto?.status === 'done' &&
    workflowLog(snapshot.simple).some(
      (e) =>
        (e.kind === 'prompt' ||
          (e.kind === 'action' &&
            launchOrigin(e) !== 'auto' &&
            ['plan', 'implement', 'review', 'fix', 'merge'].includes(e.action))) &&
        e.atMs > (auto.log.at(-1)?.atMs ?? 0),
    )
  const autoCurrent = auto && !['stopped', 'failed'].includes(auto.status) && !manualAfterAuto
  const base = (autoCurrent ? auto.merge.destinationBranch : snapshot.base) || 'base branch'
  const mergePrompt = (): StepPrompt =>
    snapshot.conflicts
      ? {
          text: snapshot.conflicts.length
            ? `Conflicts in ${snapshot.conflicts.join(', ')}.`
            : `No conflicts with ${base}. Merge?`,
          actions: [button('merge', snapshot.conflicts.length ? 'Merge with agent' : 'Merge')],
        }
      : {
          text: `No issues. Merge into ${base}?`,
          actions: [button('checkMerge', 'Merge')],
        }
  const launch = pendingLaunch(snapshot, model.records, snapshot.now)
  if (!autoCurrent && launch)
    return {
      step:
        launch.action === 'plan'
          ? 'planning'
          : launch.action === 'review'
            ? 'reviewing'
            : launch.action === 'merge'
              ? 'merging'
              : launch.action === 'fix'
                ? 'fixing'
                : 'building',
    }
  if (
    (model.stage === 'merge' &&
      (snapshot.outcome === 'merged' || snapshot.outcome === 'alreadyIntegrated')) ||
    (auto?.status === 'done' && !manualAfterAuto)
  )
    // No actions: the timeline narrates it and the step card stays away.
    return { step: 'merged', agent, prompt: { text: `Merged into ${base}.`, actions: [] } }
  if (auto && !['stopped', 'failed', 'done'].includes(auto.status)) {
    const step: SimpleStep = (
      {
        scan: 'planning',
        plan: 'planning',
        implement: 'building',
        validate: 'building',
        review: 'reviewing',
        fix: 'fixing',
        mergeGate: 'reviewed',
        merge: 'merging',
        done: 'merged',
      } as const
    )[auto.stage]
    if (auto.stage === 'mergeGate')
      return {
        step,
        agent,
        prompt: {
          text: auto.gateError ?? `Merge into ${base}?`,
          actions: [button('mergeApproval', 'Merge')],
        },
      }
    if (
      auto.status === 'paused' ||
      (auto.status === 'waitingOnYou' && auto.waitingFor !== 'agentInput')
    )
      return {
        step,
        agent,
        prompt: {
          text: auto.reason ?? 'Auto is waiting.',
          actions: [button('resumeAuto', 'Continue Auto')],
        },
      }
    return { step, agent, busyAgent: working && state?.state !== 'needsInput' ? agent : undefined }
  }
  // Role presets can launch several reviewers; one finished lane cannot advance the step
  // while another lane is still writing or waiting for input.
  const pendingReviewer =
    model.stage === 'review' &&
    model.records.find((r) => {
      if (recordStage(r) !== 'review') return false
      const s = snapshot.sessions[r.id] ?? r.snapshot
      return (
        reviewerBusy(s, !!s?.running) || (!!s?.running && awaitingTurn(snapshot.simple, r.id, s))
      )
    })
  if (pendingReviewer)
    return {
      step: 'reviewing',
      agent,
      busyAgent:
        snapshot.sessions[pendingReviewer.id]?.status?.agent?.state === 'needsInput'
          ? undefined
          : pendingReviewer,
    }
  if (working)
    return {
      step:
        model.stage === 'plan'
          ? 'planning'
          : model.stage === 'review'
            ? 'reviewing'
            : model.stage === 'merge'
              ? 'merging'
              : isFix(snapshot, agent)
                ? 'fixing'
                : 'building',
      busyAgent: state?.state === 'needsInput' ? undefined : agent,
      agent,
    }
  if (model.stage === 'merge') {
    if (snapshot.outcomePending) return { step: 'merging', agent }
    const outcome = snapshot.outcome
    return {
      step: 'merging',
      agent,
      prompt:
        outcome === 'notMerged'
          ? snapshot.conflicts
            ? mergePrompt()
            : {
                text: 'Merge has not completed.',
                actions: [button('checkMerge', 'Retry merge')],
              }
          : {
              text: snapshot.outcomeError
                ? `Merge status unavailable: ${snapshot.outcomeError}`
                : outcome === 'dirty'
                  ? 'Commit the worktree changes before merging.'
                  : outcome === 'inProgress'
                    ? 'Merge in progress…'
                    : 'Merge status unavailable. The original merge worktrees may have changed.',
              actions: [
                ...(outcome === 'dirty' && !snapshot.outcomeError
                  ? [button('merge', 'Merge again')]
                  : []),
                button('retryMergeStatus', 'Retry status'),
              ],
            },
    }
  }
  if (model.stage === 'review' && own && ended) {
    const verdict = snapshot.findings?.verdict
    if (!verdict)
      return {
        step: 'reviewed',
        agent,
        prompt: {
          text: 'Review ended without a verdict. Review again?',
          actions: [button('review', 'Review again')],
        },
      }
    const issues = Object.values(verdict.counts).reduce((sum, n) => sum + n, 0)
    return {
      step: 'reviewed',
      agent,
      prompt: snapshot.conflicts
        ? mergePrompt()
        : !verdict.clean
          ? {
              text: `${issues} issues found. Fix them?`,
              actions: [button('fix', 'Fix'), button('checkMerge', 'Merge anyway')],
            }
          : mergePrompt(),
    }
  }
  if (model.stage === 'build' && own && ended)
    return isFix(snapshot, agent)
      ? {
          step: 'fixed',
          agent,
          prompt: snapshot.conflicts
            ? mergePrompt()
            : {
                text: 'Fixes done.',
                actions: [button('review', 'Review again'), button('checkMerge', 'Merge')],
              },
        }
      : {
          step: 'built',
          agent,
          prompt: {
            text: 'Building done. Review the changes?',
            actions: [button('review', 'Review')],
          },
        }
  if (model.planReady && (!agent || ended))
    return {
      step: 'planReady',
      agent,
      prompt: {
        text: 'Build this plan?',
        actions: [button('build', 'Build'), button('plan', 'Keep planning')],
      },
    }
  return { step: own ? 'planning' : 'idle', agent }
}
/**
 * An agent this chat launched or prompted in this run that hasn't begun the turn it was given:
 * its provider confirms `idle` at startup, before the kickoff or prompt arrives. A run nobody
 * here prompted (a resume from another view) is idle at its prompt and done.
 */
export function awaitingTurn(
  simple: FlowSnapshot['simple'] | undefined,
  agentId: string,
  session: import('../types').SessionState | import('../types').TerminalSnapshot,
) {
  const latest = workflowLog(simple).findLast(
    (e) =>
      e.sessionId === agentId &&
      e.kind !== 'reply' &&
      e.generation !== undefined &&
      e.generation === session.generation,
  )
  if (!latest) return false
  const state = session.status?.agent
  return (
    latest.atMs >= (state?.sinceMs ?? 0) ||
    (state?.state === 'idle' && !state.turnId && !session.replies?.length)
  )
}
function isFix(snapshot: FlowSnapshot, agent: SessionRecord | undefined) {
  if (!agent || recordStage(agent) !== 'build') return false
  const action = workflowLog(snapshot.simple)
    .filter((e) => e.kind === 'action' && (e.action === 'fix' || e.action === 'implement'))
    .at(-1)
  return action?.kind === 'action' ? action.action === 'fix' : !!agent.metadata.branch
}

/** Stable across artifact reloads and turn activity; a new workflow attempt gets a new key. */
export function workflowPromptKey(
  snapshot: FlowSnapshot,
  model: ReturnType<typeof thread>,
  state: SimpleFlow,
): string {
  const entry = workflowLog(snapshot.simple).findLast(
    (e) =>
      e.stage === model.stage &&
      (e.kind === 'prompt' ||
        (e.kind === 'action' &&
          ['plan', 'implement', 'review', 'fix', 'merge'].includes(e.action))),
  )
  const record = model.records.filter((r) => recordStage(r) === model.stage).at(-1)
  const run = record && (snapshot.sessions[record.id] ?? record.snapshot)
  const newerRun =
    entry &&
    record &&
    (entry.sessionId === record.id
      ? entry.generation !== undefined &&
        run?.generation !== undefined &&
        run.generation > entry.generation
      : (run?.startedMs ?? record.history.at(-1)?.startedMs ?? 0) > entry.atMs)
  const attempt = entry && !newerRun ? [entry.id] : [record?.id, run?.generation, run?.startedMs]
  const promptType =
    state.step === 'merging'
      ? snapshot.outcome === 'notMerged'
        ? snapshot.conflicts
          ? 'merge'
          : 'checkMerge'
        : snapshot.outcome === 'dirty' || snapshot.outcome === 'inProgress'
          ? snapshot.outcome
          : 'status'
      : state.step
  return JSON.stringify([
    snapshot.worktree.projectId,
    snapshot.worktree.task,
    snapshot.simple?.startedMs,
    snapshot.simple?.clearBoundary?.atMs,
    snapshot.auto?.runId,
    attempt,
    state.step,
    promptType,
  ])
}

/**
 * The step card's heading: the stage its actions start, the same stage the strip marks as waiting
 * on you, so the card and the strip never name different stages.
 */
export function stepCardHeading(prompt: StepPrompt | undefined): string {
  const actions = new Set<FlowAction>(prompt?.actions.map((a) => a.action))
  if (actions.has('resumeAuto')) return 'Continue Auto mode'
  const merge = actions.has('checkMerge') || actions.has('merge') || actions.has('mergeApproval')
  if (merge && (actions.has('fix') || actions.has('review'))) return 'Review and merge'
  if (merge || actions.has('retryMergeStatus')) return 'Merge'
  if (actions.has('build')) return 'Build'
  return 'Review'
}

const STAGE_LAUNCHES = ['plan', 'implement', 'review', 'fix', 'merge']

/** Whether the newest stage launch that claimed this agent's run came from the lead. */
export function leadStarted(
  simple: FlowSnapshot['simple'] | undefined,
  agentId: string | undefined,
  generation: number | undefined,
) {
  if (!agentId) return false
  const launch = workflowLog(simple).findLast(
    (e) =>
      e.kind === 'action' &&
      e.sessionId === agentId &&
      STAGE_LAUNCHES.includes(e.action) &&
      (e.generation === undefined || generation === undefined || e.generation === generation),
  )
  return launch?.kind === 'action' && launchOrigin(launch) === 'lead'
}

const ACTIVE_REQUESTS = ['starting', 'running', 'waiting']
/** Whether a lead workflow request is still running `agentId`: its saved stage run or a council lane. */
function runsAgent(request: NonNullable<ChatTeam['requests']>[number], agentId: string) {
  return (
    ACTIVE_REQUESTS.includes(request.state) &&
    (savedStage(request.result)?.sessionId === agentId ||
      !!request.councilRun?.members.some((m) => m.sessionId === agentId))
  )
}
/**
 * Whether the lead still owns what follows a stage it started. That holds while its team is
 * running and the lead is working, has a message on its way, or still runs this agent's request.
 * Only messages being sent and requests naming this agent count: an `uncertain` delivery (as a
 * restart leaves one) has its own recovery alert and never hides the card. Once the lead is back
 * at its prompt with nothing pending, the step card returns.
 */
export function leadDeciding({
  started,
  agentId,
  team,
  lead,
}: {
  started: boolean
  agentId: string | undefined
  team: Pick<ChatTeam, 'state' | 'messages' | 'requests'> | undefined
  lead: Pick<SessionState, 'running' | 'status'> | undefined
}) {
  if (!started || !agentId || team?.state !== 'running' || !lead?.running) return false
  const state = lead.status?.agent?.state
  return (
    state === 'working' ||
    state === 'needsInput' ||
    (team.messages ?? []).some(
      (m) =>
        m.recipient === 'lead' && !m.passive && (m.state === 'pending' || m.state === 'sending'),
    ) ||
    (team.requests ?? []).some((r) => runsAgent(r, agentId))
  )
}

/** While the lead decides, the step card offers nothing and the strip says who it waits on. */
export function forLead(state: SimpleFlow, deciding: boolean): SimpleFlow {
  if (!deciding || !state.prompt?.actions.length) return state
  return { ...state, prompt: undefined, waitingOn: 'lead' }
}
/**
 * The step Chat shows. The lead decides it, except that Auto runs its own stages, and a stage
 * launched after the lead last spoke (a step-card button while it was idle) is newer news. Chats
 * whose lead hasn't set a status keep the step derived from their agents.
 */
export function chatStatus(
  derived: SimpleStep,
  {
    lead,
    autoRunning,
    simple,
  }: {
    lead?: { step: SimpleStep; note?: string | null; atMs: number } | null
    autoRunning: boolean
    simple: FlowSnapshot['simple']
  },
): { step: SimpleStep; note?: string } {
  const superseded =
    !lead ||
    autoRunning ||
    workflowLog(simple).some(
      (e) => e.kind === 'action' && STAGE_LAUNCHES.includes(e.action) && e.atMs > lead.atMs,
    )
  return superseded ? { step: derived } : { step: lead.step, note: lead.note ?? undefined }
}

export type ChatStepperStage = 'plan' | 'build' | 'review' | 'merge'
/**
 * `ready`: the stage waits for your go and nothing is wrong. `attention`: it needs you because of
 * a problem (issues, no verdict). `stopped`/`failed`: work on the current stage is halted.
 */
export type ChatStepperState =
  'done' | 'current' | 'ready' | 'attention' | 'stopped' | 'failed' | 'upcoming'
export interface ChatStepperItem {
  stage: ChatStepperStage
  state: ChatStepperState
  /** A short qualifier for the stage, such as why it is waiting on you. */
  note?: string
}
/** Why the stage in progress is not moving. */
export type ChatStepperHalt = 'paused' | 'stopped' | 'failed'

const HALT_NOTES: Record<ChatStepperHalt, string> = {
  paused: 'Paused',
  stopped: 'Stopped',
  failed: 'Failed',
}

/**
 * Where a worktree's chat is in Plan → Build → Review → Merge, projected from its `flow` step.
 * Fixing is a pass inside Review, as Auto folds fix into its build stage. `issues` counts the
 * latest review verdict's findings (undefined without a verdict); `inPlace` drops Merge. `halt`
 * marks the stage in progress as paused, stopped or failed; `note` (Auto's reason) qualifies the
 * stage in progress when the flow step gives it none, and follows a halt's label.
 */
export function chatStepper(
  step: SimpleStep,
  {
    issues,
    inPlace = false,
    halt,
    note: fallback,
  }: { issues?: number; inPlace?: boolean; halt?: ChatStepperHalt; note?: string } = {},
): ChatStepperItem[] {
  const progress: Record<SimpleStep, [index: number, state: ChatStepperState, note?: string]> = {
    idle: [-1, 'upcoming'],
    planning: [0, 'current'],
    planReady: [1, 'ready', 'Ready'],
    building: [1, 'current'],
    built: [2, 'ready', 'Ready'],
    reviewing: [2, 'current'],
    reviewed:
      issues === undefined
        ? [2, 'attention', 'No verdict']
        : issues > 0
          ? [2, 'attention', `${issues} ${issues === 1 ? 'issue' : 'issues'}`]
          : [3, 'ready', 'Ready'],
    fixing: [2, 'current', 'Fixing'],
    fixed: [2, 'ready', 'Re-review'],
    merging: [3, 'current'],
    merged: [4, 'done'],
  }
  const stages: ChatStepperStage[] = [
    'plan',
    'build',
    'review',
    ...(inPlace ? [] : ['merge' as const]),
  ]
  // A run in place ends at review: a clean verdict completes it.
  const [at, state, note] =
    inPlace && progress[step][0] >= 3 ? ([4, 'done'] as const) : progress[step]
  const shown: Pick<ChatStepperItem, 'state' | 'note'> = halt
    ? {
        state: halt === 'failed' ? 'failed' : 'stopped',
        note: [HALT_NOTES[halt], fallback].filter(Boolean).join(' · '),
      }
    : { state, note: note ?? fallback }
  return stages.map((stage, i) =>
    i < at
      ? { stage, state: 'done' }
      : i === at
        ? { stage, ...shown }
        : { stage, state: 'upcoming' },
  )
}
