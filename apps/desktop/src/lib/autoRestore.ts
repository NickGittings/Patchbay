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
      ...(auto.autonomous === true ? { autonomous: true } : {}),
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
  const usageWait =
    r.usageWait &&
    Number.isFinite(r.usageWait.atMs) &&
    Array.isArray(r.usageWait.providers) &&
    r.usageWait.providers.length > 0 &&
    r.usageWait.providers.every((p) => p === 'claude' || p === 'codex')
      ? r.usageWait
      : undefined
  const trigger = r.resumeTrigger
  const scheduled =
    !finished &&
    r.status === 'paused' &&
    trigger &&
    Number.isFinite(trigger.atMs) &&
    ((trigger.kind === 'time' && r.pauseKind === 'scheduled') ||
      (trigger.kind === 'usage' &&
        r.pauseKind === 'usage' &&
        r.resumeOnUsageReset === true &&
        usageWait))
      ? trigger
      : undefined
  const restoredPause =
    r.status === 'paused' &&
    ((r.pauseKind === 'usage' && usageWait) || (r.pauseKind === 'scheduled' && scheduled))
      ? r.pauseKind
      : pauseKind
  return {
    autonomous: r.autonomous === true,
    restartPending:
      r.autonomous === true &&
      (r.status === 'running' ||
        (r.status === 'paused' && r.pauseKind === 'restored' && r.restartPending === true)),
    recovery:
      r.recovery &&
      STAGES.includes(r.recovery.stage) &&
      typeof r.recovery.mark === 'string' &&
      Number.isInteger(r.recovery.attempts) &&
      r.recovery.attempts >= 0 &&
      r.recovery.attempts <= 3 &&
      typeof r.recovery.reason === 'string'
        ? {
            stage: r.recovery.stage,
            mark: r.recovery.mark,
            attempts: r.recovery.attempts,
            action: typeof r.recovery.action === 'string' ? r.recovery.action : undefined,
            atMs: finite(r.recovery.atMs),
            pending: r.recovery.pending === true,
            reason: r.recovery.reason,
          }
        : undefined,
    resumeOnUsageReset: r.resumeOnUsageReset === true,
    usageWait:
      !finished && r.status === 'paused' && r.pauseKind === 'usage' ? usageWait : undefined,
    resumeTrigger: scheduled,
    runId: r.runId,
    ...(typeof r.ownershipId === 'string' ? { ownershipId: r.ownershipId } : {}),
    stage: r.stage,
    goal: r.goal,
    effort: r.effort,
    overrides: r.overrides,
    merge: r.merge,
    device: r.device,
    agents: restoredAgents(r.agents),
    scanners: Array.isArray(r.scanners) ? restoredPresetIds(r.scanners) : undefined,
    workers: Array.isArray(r.workers) ? restoredPresetIds(r.workers) : undefined,
    scanRound: typeof r.scanRound === 'string' ? r.scanRound : undefined,
    implementationRun: typeof r.implementationRun === 'string' ? r.implementationRun : undefined,
    implementationLaunch:
      typeof r.implementationLaunch === 'string' ? r.implementationLaunch : undefined,
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
    pauseKind: finished ? undefined : restoredPause,
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
    validationMark: typeof r.validationMark === 'string' ? r.validationMark : undefined,
    validationHead: typeof r.validationHead === 'string' ? r.validationHead : undefined,
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
      : restoredPause === 'usage' ||
          restoredPause === 'scheduled' ||
          pauseKind === 'user' ||
          pauseKind === 'needsUser'
        ? typeof r.reason === 'string'
          ? r.reason
          : 'Paused — Resume?'
        : 'Restored after restart — Resume?',
  }
}
