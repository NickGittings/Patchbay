import type { AutoRun } from '../types'
import { EFFORT, SEVERITIES, STAGES } from './autoSettings'

/** Persisted controllers are inert until the user explicitly resumes; finished runs stay finished. */
export function restoredAuto(value: unknown): AutoRun | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as AutoRun
  if (
    typeof r.runId !== 'string' ||
    typeof r.goal !== 'string' ||
    typeof r.device !== 'string' ||
    !STAGES.includes(r.stage) ||
    !Object.hasOwn(EFFORT, r.effort) ||
    !Number.isInteger(r.round) ||
    r.round < 0 ||
    !r.merge ||
    !['ask', 'auto'].includes(r.merge.mode) ||
    typeof r.merge.destinationBranch !== 'string' ||
    !Array.isArray(r.log)
  )
    return null
  const overrides = r.overrides
  if (
    overrides &&
    (typeof overrides !== 'object' ||
      (overrides.maxRounds !== undefined &&
        (!Number.isInteger(overrides.maxRounds) ||
          overrides.maxRounds < 0 ||
          overrides.maxRounds > 100)) ||
      (overrides.severityFloor !== undefined && !SEVERITIES.includes(overrides.severityFloor)) ||
      (overrides.validate !== undefined && typeof overrides.validate !== 'boolean'))
  )
    return null
  const finished = ['done', 'stopped', 'failed'].includes(r.status)
  return {
    runId: r.runId,
    stage: r.stage,
    goal: r.goal,
    effort: r.effort,
    overrides: r.overrides,
    merge: r.merge,
    device: r.device,
    round: r.round,
    status: finished ? r.status : 'paused',
    reviewedHead: typeof r.reviewedHead === 'string' ? r.reviewedHead : undefined,
    validation: Array.isArray(r.validation)
      ? r.validation.filter(
          (report) =>
            report &&
            report.plan &&
            Array.isArray(report.plan.skipped) &&
            Array.isArray(report.results),
        )
      : undefined,
    findingsSummary: typeof r.findingsSummary === 'string' ? r.findingsSummary : undefined,
    validationFindings: typeof r.validationFindings === 'string' ? r.validationFindings : undefined,
    log: r.log
      .filter((l) => l && Number.isFinite(l.atMs) && typeof l.text === 'string')
      .slice(-100),
    reason: finished
      ? typeof r.reason === 'string'
        ? r.reason
        : undefined
      : 'Restored after restart — Resume?',
  }
}
