import type { ActionReport, AutoRun, AutoStage, EffortSettings, MergeOutcome } from '../types'
import { SEVERITIES } from '../types'

/** A run that still tracks its work: it can be resumed, and it briefs its agent. */
export const unfinished = (status: AutoRun['status'] | undefined) =>
  status === 'running' || status === 'waitingOnYou' || status === 'paused'
/** A run that ended and stays so, restored or not. */
export const finished = (status: AutoRun['status'] | undefined) =>
  status === 'done' || status === 'stopped' || status === 'failed'
/** The source branch's work is in its destination. */
export const integrated = (outcome: MergeOutcome | undefined) =>
  outcome === 'merged' || outcome === 'alreadyIntegrated'

export const STATUS_LABELS: Record<AutoRun['status'], string> = {
  running: 'Running',
  paused: 'Paused',
  waitingOnYou: 'Waiting on you',
  stopped: 'Stopped',
  done: 'Done',
  failed: 'Failed',
}

export const EFFORT: Record<AutoRun['effort'], EffortSettings & { note: string }> = {
  light: {
    maxRounds: 1,
    severityFloor: 'high',
    validate: false,
    note: 'Make minimal, targeted changes.',
  },
  standard: {
    maxRounds: 3,
    severityFloor: 'medium',
    validate: true,
    note: 'Fix properly; add tests where cheap.',
  },
  thorough: {
    maxRounds: 5,
    severityFloor: 'low',
    validate: true,
    note: 'Fix root causes and add tests.',
  },
}
export const STAGE_LABELS: Record<AutoStage, string> = {
  plan: 'Plan',
  implement: 'Implement',
  validate: 'Validate',
  review: 'Review',
  fix: 'Fix',
  mergeGate: 'Merge approval',
  merge: 'Merge',
  done: 'Done',
}
export const STAGES: AutoStage[] = [
  'plan',
  'implement',
  'validate',
  'review',
  'fix',
  'mergeGate',
  'merge',
  'done',
]
/** The most fix rounds Advanced allows. */
export const MAX_ROUNDS = 100

/** Whether `overrides` holds only valid Advanced settings (any may be absent). */
export function validOverrides(overrides: Partial<EffortSettings>) {
  return (
    (overrides.maxRounds === undefined ||
      (Number.isInteger(overrides.maxRounds) &&
        overrides.maxRounds >= 0 &&
        overrides.maxRounds <= MAX_ROUNDS)) &&
    (overrides.severityFloor === undefined || SEVERITIES.includes(overrides.severityFloor)) &&
    (overrides.validate === undefined || typeof overrides.validate === 'boolean')
  )
}

/** A validation task that passed, mirroring the outcomes `ActionReport::failed` accepts. */
export const taskPassed = (result: ActionReport['results'][number]) =>
  ['passed', 'started', 'reused'].includes(result.outcome)
