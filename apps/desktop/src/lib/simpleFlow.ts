import type { MergeOutcome, ReviewFindings, SessionRecord } from '../types'
import { reviewerBusy } from './review'
import {
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
  'build' | 'plan' | 'review' | 'fix' | 'checkMerge' | 'merge' | 'resumeAuto' | 'mergeApproval'
export interface StepPrompt {
  text: string
  actions: { action: FlowAction; label: string }[]
}
export interface FlowSnapshot extends SimpleSnapshot {
  worktree: SimpleWorktree
  findings?: ReviewFindings | null
  outcome?: MergeOutcome
  base?: string
  conflicts?: string[]
  /** The time to judge a launch's missing record against; without it one is always pending. */
  now?: number
}
/**
 * How long a logged launch whose run has no record yet still reads as starting. Records
 * reconcile within seconds of a launch; one missing past this was forgotten, and the chat
 * falls back to its usual prompts rather than staying stuck without actions.
 */
export const LAUNCH_RECORD_GRACE_MS = 30_000
export interface SimpleFlow {
  step: SimpleStep
  prompt?: StepPrompt
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
  agent = selectRecipient(model.records, snapshot.sessions, model.stage, undefined, model.foreign),
): SimpleFlow {
  // A shared planner another chat is using is no agent of this conversation.
  const own = agent && !model.foreign.has(agent.id) ? agent : undefined
  const session = own ? (snapshot.sessions[own.id] ?? own.snapshot) : undefined
  const state = session?.status?.agent
  const ended =
    !own ||
    (!!session &&
      (!session.running ||
        (!awaitingTurn(snapshot, own, session) &&
          (state?.state === 'review' ||
            state?.state === 'ended' ||
            (state?.state === 'idle' && !!state.authoritative)))))
  const working = !!own && !ended
  const auto = snapshot.auto
  const manualAfterAuto =
    auto?.status === 'done' &&
    snapshot.simple?.log.some(
      (e) =>
        (e.kind === 'prompt' ||
          (e.kind === 'action' &&
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
  const launch = pendingLaunch(snapshot, model.records)
  if (
    !autoCurrent &&
    launch &&
    (snapshot.now === undefined || snapshot.now - launch.atMs < LAUNCH_RECORD_GRACE_MS)
  )
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
    return { step: 'merged', agent, prompt: { text: `Merged into ${base}.`, actions: [] } }
  if (auto && !['stopped', 'failed', 'done'].includes(auto.status)) {
    const step: SimpleStep = (
      {
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
      return reviewerBusy(s, !!s?.running) || (!!s?.running && awaitingTurn(snapshot, r, s))
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
  if (model.stage === 'merge')
    return {
      step: 'merging',
      agent,
      prompt: {
        text:
          snapshot.outcome === 'dirty'
            ? 'Commit the worktree changes before merging.'
            : 'Merge has not completed.',
        actions: [button('checkMerge', 'Check conflicts')],
      },
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
function awaitingTurn(
  snapshot: FlowSnapshot,
  agent: SessionRecord,
  session: import('../types').SessionState | import('../types').TerminalSnapshot,
) {
  const latest = snapshot.simple?.log.findLast(
    (e) =>
      e.sessionId === agent.id &&
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
  const action = snapshot.simple?.log
    .filter((e) => e.kind === 'action' && (e.action === 'fix' || e.action === 'implement'))
    .at(-1)
  return action?.kind === 'action' ? action.action === 'fix' : !!agent.metadata.branch
}
