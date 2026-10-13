import type { AutoRun } from '../types'

/** Persisted controllers are inert until the user explicitly resumes. */
export function restoredAuto(value: unknown): AutoRun | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as AutoRun
  if (
    typeof r.runId !== 'string' ||
    typeof r.goal !== 'string' ||
    typeof r.device !== 'string' ||
    !['plan', 'implement', 'validate', 'review', 'fix', 'mergeGate', 'merge', 'done'].includes(
      r.stage,
    ) ||
    !['light', 'standard', 'thorough'].includes(r.effort) ||
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
      (overrides.severityFloor !== undefined &&
        !['critical', 'high', 'medium', 'low'].includes(overrides.severityFloor)) ||
      (overrides.validate !== undefined && typeof overrides.validate !== 'boolean'))
  )
    return null
  return {
    runId: r.runId,
    stage: r.stage,
    goal: r.goal,
    effort: r.effort,
    overrides: r.overrides,
    merge: r.merge,
    device: r.device,
    round: r.round,
    status: 'paused',
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
    reason: 'Restored after restart — Resume?',
  }
}
