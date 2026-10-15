import type { ActionReport, AutoRun, AutoStage, EffortSettings, Severity } from '../types'

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
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low']
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

/** A validation task that passed, mirroring the outcomes `ActionReport::succeeded` accepts. */
export const taskPassed = (result: ActionReport['results'][number]) =>
  ['passed', 'started', 'reused'].includes(result.outcome)
