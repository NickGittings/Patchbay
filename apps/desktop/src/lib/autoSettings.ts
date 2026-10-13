import type { AutoRun, AutoStage, EffortSettings, Severity } from '../types'

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
