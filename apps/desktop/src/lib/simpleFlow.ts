import type { MergeOutcome, ReviewFindings, SessionRecord } from '../types'
import {
  recordStage,
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
}
export interface SimpleFlow {
  step: SimpleStep
  prompt?: StepPrompt
  busyAgent?: SessionRecord
  agent?: SessionRecord
}
const button = (action: FlowAction, label: string) => ({ action, label })

/** State alone scripts the chat. No models, terminal parsing, or effects. */
export function flow(snapshot: FlowSnapshot): SimpleFlow {
  const model = thread(snapshot, snapshot.worktree)
  const agent = selectRecipient(model.records, snapshot.sessions, model.stage)
  const session = agent ? (snapshot.sessions[agent.id] ?? agent.snapshot) : undefined
  const state = session?.status?.agent
  const ended =
    !!session &&
    (!session.running ||
      state?.state === 'review' ||
      state?.state === 'ended' ||
      (state?.state === 'idle' &&
        state.authoritative &&
        (!!state.turnId || !!session.replies?.length)))
  const working = !!agent && !ended
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
      const a = s?.status?.agent
      return s?.running && (!a || !['review', 'idle', 'ended'].includes(a.state))
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
  if (model.stage === 'review' && ended) {
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
  if (model.stage === 'build' && ended)
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
  return { step: agent ? 'planning' : 'idle', agent }
}
function isFix(snapshot: FlowSnapshot, agent: SessionRecord | undefined) {
  if (!agent || recordStage(agent) !== 'build') return false
  const action = snapshot.simple?.log
    .filter((e) => e.kind === 'action' && (e.action === 'fix' || e.action === 'implement'))
    .at(-1)
  return action?.kind === 'action' ? action.action === 'fix' : !!agent.metadata.branch
}
