import type { AutoRun, AutoStage } from '../types'
import { chatAutoActive } from './chat'
import type { ChatTeam } from './chatTeams'
import { launchOrigin, thread, workflowLog, type SimpleState } from './simple'
import {
  chatStatus,
  chatStepper,
  flow,
  forLead,
  leadDeciding,
  leadStarted,
  type ChatStepperItem,
  type FlowSnapshot,
  type SimpleStep,
} from './simpleFlow'

/** The Chat step each Auto stage shows as. */
const AUTO_STEPS: Record<AutoStage, SimpleStep> = {
  scan: 'planning',
  plan: 'planning',
  implement: 'building',
  validate: 'building',
  review: 'reviewing',
  fix: 'fixing',
  mergeGate: 'reviewed',
  merge: 'merging',
  done: 'merged',
}
/** Auto stages the strip folds into another stage name them in its note. */
const AUTO_NOTES: Partial<Record<AutoStage, string>> = {
  scan: 'Scanning',
  validate: 'Validating',
}
const STAGE_LAUNCHES = ['plan', 'implement', 'review', 'fix', 'merge']

export const autoStep = (run: Pick<AutoRun, 'stage'>): SimpleStep => AUTO_STEPS[run.stage]
const runsInPlace = (run: Pick<AutoRun, 'baseCommit'>) => !!run.baseCommit

/**
 * Whether Auto's run is still the latest work in its worktree. A running, waiting or paused run
 * always is. A finished, stopped or failed one is until someone launches a stage or prompts an
 * agent outside it, from Chat, the regular views or the lead.
 */
export function autoCurrent(
  auto: Pick<AutoRun, 'status' | 'log'> | null | undefined,
  simple: SimpleState | null | undefined,
) {
  if (!auto) return false
  if (!['done', 'stopped', 'failed'].includes(auto.status)) return true
  const endedMs = auto.log.at(-1)?.atMs ?? 0
  return !workflowLog(simple).some(
    (e) =>
      e.atMs > endedMs &&
      (e.kind === 'prompt' ||
        (e.kind === 'action' && STAGE_LAUNCHES.includes(e.action) && launchOrigin(e) !== 'auto')),
  )
}

/**
 * Plan → Build → Review → Merge for an Auto run, as Chat and the Auto panel both show it. Fix is
 * a pass inside Review; scanning and validating are notes on Plan and Build. The merge gate waits
 * for your go; any other wait needs your attention.
 */
export function autoStepper(
  run: Pick<AutoRun, 'stage' | 'status' | 'reason' | 'baseCommit'>,
): ChatStepperItem[] {
  const halt =
    run.status === 'paused' || run.status === 'failed' || run.status === 'stopped'
      ? run.status
      : undefined
  return chatStepper(autoStep(run), {
    // Auto only reaches its merge gate past its fix floor.
    issues: run.stage === 'mergeGate' ? 0 : undefined,
    inPlace: runsInPlace(run),
    halt,
    // Waiting on an agent's question is waiting on you too, as is any wait but the merge gate.
    attention: run.status === 'waitingOnYou' && run.stage !== 'mergeGate',
    note: run.reason || AUTO_NOTES[run.stage],
  })
}

export interface StageModelInput {
  snapshot: FlowSnapshot
  model?: ReturnType<typeof thread>
  team?: ChatTeam
}

/**
 * Where a worktree's work is and what comes next, the same in Chat, the Auto panel and the Plan
 * and Review views. State alone decides it: sessions, the chat's workflow log, the Auto run,
 * artifacts and the lead's status.
 */
export function stageModel({ snapshot, model, team }: StageModelInput) {
  const threaded = model ?? thread(snapshot, snapshot.worktree)
  const { auto, simple, sessions } = snapshot
  const flowed = flow(snapshot, threaded)
  // The lead decides what follows a stage it started; the card returns once it is done deciding.
  const derived = forLead(
    flowed,
    leadDeciding({
      agentId: flowed.agent?.id,
      started: leadStarted(simple, flowed.agent?.id, sessions[flowed.agent?.id ?? '']?.generation),
      team,
      lead: team ? sessions[team.lead.sessionId] : undefined,
    }),
  )
  const status = chatStatus(derived.step, {
    lead: team?.status,
    autoRunning: !!auto && !['stopped', 'failed', 'done'].includes(auto.status),
    simple,
  })
  // The derived prompt belongs to the derived step, so it goes when the lead says otherwise.
  const state =
    status.step === derived.step ? derived : { ...derived, step: status.step, prompt: undefined }
  const current = autoCurrent(auto, simple)
  const autoActive = chatAutoActive(auto?.status)
  const autoHalt =
    current && (auto?.status === 'paused' || auto?.status === 'failed') ? auto.status : undefined
  // A stopped run hands the worktree back to you; any other current run shows as Auto shows it.
  const autoShown = !!auto && current && auto.status !== 'stopped'
  const verdict = snapshot.findings?.verdict
  const stepper = autoShown
    ? autoStepper(auto)
    : chatStepper(state.step, {
        issues: verdict ? Object.values(verdict.counts).reduce((sum, n) => sum + n, 0) : undefined,
        // A worktree Auto ran in place has no Merge, even once later work follows the run.
        inPlace: !!auto && !['stopped', 'failed'].includes(auto.status) && runsInPlace(auto),
        halt: team?.state === 'paused' || team?.state === 'stopped' ? team.state : undefined,
        note: status.note ?? (state.waitingOn === 'lead' ? 'Lead deciding' : undefined),
      })
  const driver: 'auto' | 'lead' | 'user' =
    autoActive || autoHalt === 'paused'
      ? 'auto'
      : state.waitingOn === 'lead' || (team?.state === 'running' && !!team.status)
        ? 'lead'
        : 'user'
  return {
    model: threaded,
    flow: flowed,
    state,
    status,
    stepper,
    autoActive,
    autoHalt,
    autoCurrent: current,
    /** Whether the strip shows at all: something has happened or Auto is on. */
    visible: state.step !== 'idle' || autoActive || !!autoHalt,
    driver,
  }
}
export type StageModel = ReturnType<typeof stageModel>
