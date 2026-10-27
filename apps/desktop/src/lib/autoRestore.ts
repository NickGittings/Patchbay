import type { AutoRun } from '../types'
import { restoredAgents, restoredPresetIds } from './agentRoles'
import { SEVERITIES } from '../types'
import { EFFORT, finished as ended, STAGES, validOverrides } from './autoSettings'

const finite = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : undefined)

/** A brief the backend can read, so a tracked terminal can still start. */
function restoredBrief(value: AutoRun['sessionBrief']): AutoRun['sessionBrief'] {
  const auto = value?.auto
  const kickoff = value?.kickoff
  if (
    typeof value?.sessionId !== 'string' ||
    !auto ||
    typeof auto.goal !== 'string' ||
    typeof auto.effortNote !== 'string' ||
    typeof auto.commit !== 'boolean' ||
    !(auto.fixFloor === null || SEVERITIES.includes(auto.fixFloor)) ||
    (kickoff !== undefined && kickoff?.kind !== 'plan')
  )
    return undefined
  return {
    sessionId: value.sessionId,
    auto: {
      goal: auto.goal,
      fixFloor: auto.fixFloor,
      effortNote: auto.effortNote,
      commit: auto.commit,
    },
    kickoff: kickoff ? { kind: 'plan' } : undefined,
  }
}

/** Restored controllers are inert; pause kinds preserve choices a scheduler must never override. */
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
  if (r.overrides && (typeof r.overrides !== 'object' || !validOverrides(r.overrides))) return null
  const finished = ended(r.status)
  // Legacy pauses have no provenance: treat them as deliberate, rather than resuming them later.
  const pauseKind =
    r.status === 'waitingOnYou'
      ? 'needsUser'
      : r.status === 'paused'
        ? r.pauseKind === 'user' || r.pauseKind === 'needsUser'
          ? r.pauseKind
          : ['restored', 'inactive', 'interrupted'].includes(r.pauseKind ?? '')
            ? 'restored'
            : 'user'
        : 'restored'
  return {
    runId: r.runId,
    stage: r.stage,
    goal: r.goal,
    effort: r.effort,
    overrides: r.overrides,
    merge: r.merge,
    device: r.device,
    agents: restoredAgents(r.agents),
    reviewers: Array.isArray(r.reviewers) ? restoredPresetIds(r.reviewers) : undefined,
    // Reviewers beside the tracked session keep running in the service too.
    laneSessions: Array.isArray(r.laneSessions)
      ? r.laneSessions.flatMap((l) =>
          l && typeof l.sessionId === 'string'
            ? [
                {
                  sessionId: l.sessionId,
                  startedMs: finite(l.startedMs),
                  ...(typeof l.requestId === 'string' ? { requestId: l.requestId } : {}),
                  ...(typeof l.lane === 'string' || l.lane === null ? { lane: l.lane } : {}),
                  ...(finite(l.turnSince) !== undefined ? { turnSince: finite(l.turnSince) } : {}),
                  ...(l.observedWorking === true ? { observedWorking: true } : {}),
                },
              ]
            : [],
        )
      : undefined,
    branch: typeof r.branch === 'string' ? r.branch : undefined,
    round: r.round,
    status: finished ? r.status : 'paused',
    background: r.background === true,
    pauseKind: finished ? undefined : pauseKind,
    pausedMs: finished
      ? undefined
      : ((r.status === 'paused' ? finite(r.pausedMs) : undefined) ?? Date.now()),
    // Agents outlive the app in the session service, so Auto keeps tracking (and owning) them.
    sessionId: typeof r.sessionId === 'string' ? r.sessionId : undefined,
    // Ownership needs the launch's start time, or a later session under the same id would count.
    // Owned only with a generation to check: its start time, else its launch request.
    sessionOwned:
      r.sessionOwned === true &&
      (finite(r.sessionStartedMs) !== undefined || typeof r.sessionRequestId === 'string'),
    sessionStartedMs: finite(r.sessionStartedMs),
    sessionRequestId: typeof r.sessionRequestId === 'string' ? r.sessionRequestId : undefined,
    sessionLane:
      typeof r.sessionLane === 'string' || r.sessionLane === null ? r.sessionLane : undefined,
    reviewRound: typeof r.reviewRound === 'string' ? r.reviewRound : undefined,
    turnSince: finite(r.turnSince),
    launchAtMs: finite(r.launchAtMs),
    observedWorking: r.observedWorking === true,
    sessionBrief: restoredBrief(r.sessionBrief),
    planMark: typeof r.planMark === 'string' ? r.planMark : undefined,
    plannerTurn: typeof r.plannerTurn === 'boolean' ? r.plannerTurn : undefined,
    waitingFor: r.waitingFor === 'fixBudget' ? 'fixBudget' : undefined,
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
    validationFindings: typeof r.validationFindings === 'string' ? r.validationFindings : undefined,
    log: r.log
      .filter((l) => l && Number.isFinite(l.atMs) && typeof l.text === 'string')
      .slice(-100),
    // `gateError` isn't restored: only a live approval wait reports one, and it polls again.
    reason: finished
      ? typeof r.reason === 'string'
        ? r.reason
        : undefined
      : pauseKind === 'user' || pauseKind === 'needsUser'
        ? typeof r.reason === 'string'
          ? r.reason
          : 'Paused — Resume?'
        : 'Restored after restart — Resume?',
  }
}
