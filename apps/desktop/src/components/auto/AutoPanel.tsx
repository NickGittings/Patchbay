import { setAutoKeepAwake, useAutoPower } from '../../lib/autoPower'
import { logSimple } from '../../lib/simpleActions'
import { simpleStageOf, type SimpleAction } from '../../lib/simple'
import { useState } from 'react'
import { useStore } from '../../store'
import { parseSessionId, type ActionReport, type AutoRun } from '../../types'
import {
  cancelAutoResume,
  scheduleAutoResume,
  setAutoUsageResume,
  effortSettings,
  inPlace,
  mergeNow,
  pauseAuto,
  resumeAuto,
  skipStage,
  stopAuto,
  STAGE_LABELS,
} from '../../lib/auto'
import { revealTerminal } from '../../lib/attention'
import AutoDialog from './AutoDialog'
import type { HookProvider } from '../../lib/agentHooks'
import { autoDraftKey, autoDrafts } from '../../lib/autoDrafts'
import { finished as ended, STATUS_LABELS, taskPassed } from '../../lib/autoSettings'
import PanelContent from '../PanelContent'
import { PanelDetails } from '../PanelSection'
import { SeverityCounts, VerdictBadge } from '../findings/FindingsPanel'
import { useRunningReviewLanes } from '../../lib/reviewAgents'
import { useReviewFindings } from '../../lib/useReviewFindings'
import { activeTaskOf } from '../../lib/tasks'
import { shortSha } from '../../lib/commitId'
import './auto.css'

function validationSummary(reports: ActionReport[]) {
  const checks = reports.flatMap((report) => report.results)
  if (!checks.length) return 'No checks ran'
  const failed = checks.filter((check) => !taskPassed(check)).length
  if (failed) return `${failed} of ${checks.length} checks did not pass`
  return `${checks.length} ${checks.length === 1 ? 'check' : 'checks'} passed`
}

export default function AutoPanel({
  onIntegrations,
  simple = false,
}: {
  onIntegrations: (provider?: HookProvider) => void
  simple?: boolean
}) {
  const keepAwake = useStore((s) => s.workspaceSettings.autoKeepAwake === true)
  const power = useAutoPower()
  const run = useStore((s) => s.auto)
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const draftVersion = useStore((s) => s.autoDraftVersion)
  const [error, setError] = useState('')
  // Tied to the run and pause it came from, so a later pause or another worktree starts clean.
  const [scheduleError, setScheduleError] = useState<{ key: string; message: string }>()
  const [resumeTime, setResumeTime] = useState('')
  // The finished run New run was pressed for; another run or worktree shows its own state.
  const [newRunFor, setNewRunFor] = useState<string | null>(null)
  const finished = !!run && ended(run.status)
  const newRun =
    finished &&
    (newRunFor === JSON.stringify([projectId, task, run.runId]) ||
      !!autoDrafts.get(autoDraftKey(projectId, task))?.story)
  const act = (
    action: SimpleAction,
    fn: (id: string, task: string | null) => void | Promise<void>,
  ) => {
    if (projectId)
      void Promise.resolve(fn(projectId, task))
        .then(() => {
          if (simple)
            // Auto controls name the agent for the conversation but never claim its run.
            logSimple(projectId, task, {
              kind: 'action',
              action,
              stage: simpleStageOf(run?.stage),
              sessionId: run?.sessionId,
            })
        })
        .catch((e) => setError(String(e)))
  }
  // Opens Power when sleep prevention can't do its job, so the warning isn't left collapsed.
  const powerProblem =
    keepAwake &&
    (['onBattery', 'powerUnknown', 'unavailable'].includes(power.status) || !!power.error)
  const powerSection = (
    <PanelDetails title="Power" reveal={powerProblem}>
      <label className="auto-check auto-toggle">
        <input
          type="checkbox"
          checked={keepAwake}
          onChange={(e) => setAutoKeepAwake(e.target.checked)}
        />
        Keep device awake for Auto work
      </label>
      <small className="auto-hint">
        While plugged in, prevent idle sleep during Auto work and scheduled waits. Keep Patchbay
        open. The screen can turn off. This does not wake a sleeping device.
      </small>
      {keepAwake && (
        <p role="status" className="auto-hint">
          {
            {
              inactive: 'Sleep prevention is idle.',
              active: 'Keeping device awake while plugged in.',
              onBattery: 'On battery: scheduled work may wait until the device wakes.',
              powerUnknown: 'Power source unknown: sleep prevention is inactive.',
              unavailable: 'Sleep prevention unavailable.',
            }[power.status]
          }
          {power.error && ` ${power.error}`}
        </p>
      )}
    </PanelDetails>
  )
  if (!run || newRun)
    return (
      <PanelContent>
        <AutoDialog
          key={`${autoDraftKey(projectId, task)}/${draftVersion}`}
          onIntegrations={onIntegrations}
          simple={simple}
        />
        {powerSection}
      </PanelContent>
    )
  const steps = [
    ...(run.scanners?.length || run.scanRound ? ['scan' as const] : []),
    'plan' as const,
    'implement' as const,
    'validate' as const,
    'review' as const,
    // A run in place ends after review.
    ...(inPlace(run) ? [] : ['merge' as const]),
  ]
  const current = currentStep(run)
  const currentIndex = steps.indexOf(current)
  const tone = STATUS_TONES[run.status]
  const stoppable = !['done', 'stopped'].includes(run.status)
  const scheduleKey = JSON.stringify([projectId, task, run.runId, run.status, run.stage])
  return (
    <PanelContent>
      <div className="auto-content">
        <header className="auto-run-head">
          <div className="auto-run-status">
            <span className={`worktree-tag${tone ? ` ${tone}` : ''}`}>
              {run.status === 'running' && <span className="status-dot" aria-hidden />}
              {STATUS_LABELS[run.status]}
            </span>
            {run.sessionId && (
              <button
                className="auto-session-link"
                onClick={() =>
                  revealTerminal({
                    sid: run.inputSessionId ?? run.sessionId!,
                    componentId: parseSessionId(run.inputSessionId ?? run.sessionId!).componentId,
                  })
                }
              >
                Open current session
              </button>
            )}
          </div>
          <p className="auto-goal" title={run.goal}>
            {run.goal}
          </p>
        </header>
        <ol className="auto-stepper" aria-label="Run stages">
          {steps.map((stage, i) => (
            <li
              key={stage}
              aria-current={stage === current ? 'step' : undefined}
              data-state={
                i < currentIndex || (i === currentIndex && run.status === 'done')
                  ? 'done'
                  : i === currentIndex
                    ? CURRENT_STEP_STATES[run.status]
                    : 'upcoming'
              }
            >
              {STAGE_LABELS[stage]}
            </li>
          ))}
        </ol>
        {(run.autonomous || run.recovery) && (
          <div className="auto-meta">
            {run.autonomous && (
              <small>
                Autonomous execution ·{' '}
                {inPlace(run)
                  ? 'In place, no merge'
                  : run.merge.mode === 'auto'
                    ? 'Automatic merge after review'
                    : 'Merge approval required'}
              </small>
            )}
            {run.recovery && (
              <small role="status">
                Recovery {run.recovery.attempts}/3 without progress: {run.recovery.reason}
              </small>
            )}
          </div>
        )}
        {['paused', 'waitingOnYou', 'failed'].includes(run.status) &&
          (run.reason || run.gateError) && (
            <p
              className="auto-callout"
              data-tone={run.status === 'failed' ? 'bad' : 'attention'}
              role="status"
            >
              {run.gateError ? `Couldn't check merge status: ${run.gateError}` : run.reason}
            </p>
          )}
        {run.branch && ['review', 'fix', 'mergeGate', 'merge', 'done'].includes(run.stage) && (
          <AutoFindings
            projectId={projectId}
            branch={run.branch}
            refresh={`${run.stage}:${run.status}:${run.log.length}`}
          />
        )}
        <div className="auto-controls">
          {run.stage === 'mergeGate' && run.status === 'waitingOnYou' && !inPlace(run) && (
            <button className="primary" onClick={() => act('mergeApproval', mergeNow)}>
              Merge now
            </button>
          )}
          {run.status === 'running' ? (
            <button onClick={() => act('pauseAuto', pauseAuto)}>Pause</button>
          ) : (
            stoppable && (
              <button
                className={
                  run.stage === 'mergeGate' && run.status === 'waitingOnYou' ? undefined : 'primary'
                }
                onClick={() => act('resumeAuto', (id, task) => resumeAuto(id, task))}
              >
                {run.resumeTrigger ? 'Resume now' : 'Resume'}
              </button>
            )
          )}
          {finished && (
            <button
              className={run.status === 'failed' ? undefined : 'primary'}
              onClick={() => setNewRunFor(JSON.stringify([projectId, task, run.runId]))}
            >
              New run
            </button>
          )}
          {['paused', 'failed', 'waitingOnYou'].includes(run.status) && (
            <button onClick={() => act('skipStage', skipStage)}>
              {run.stage === 'scan' ? 'Continue with available findings' : 'Skip stage'}
            </button>
          )}
          {stoppable && (
            <button className="auto-stop" onClick={() => act('stopAuto', stopAuto)}>
              Stop
            </button>
          )}
        </div>
        {error && (
          <p className="auto-callout" data-tone="bad" role="alert">
            {error}
          </p>
        )}
        {(!finished || run.resumeTrigger) && (
          <section className="auto-group" aria-label="Resume">
            {!finished && (
              <label className="auto-toggle">
                <input
                  type="checkbox"
                  checked={run.resumeOnUsageReset === true}
                  onChange={(e) =>
                    projectId && setAutoUsageResume(projectId, task, e.target.checked)
                  }
                />
                Resume when usage resets
              </label>
            )}
            {run.resumeTrigger && (
              <div className="auto-schedule" role="status">
                <span>
                  Resume {run.resumeTrigger.kind === 'usage' ? 'after usage reset' : 'scheduled'}:{' '}
                  <strong>
                    {new Date(run.resumeTrigger.atMs).toLocaleString(undefined, {
                      timeZoneName: 'short',
                    })}
                  </strong>
                  <small className="auto-hint">
                    Requires Patchbay open and this worktree active or background work enabled.
                  </small>
                </span>
                <button onClick={() => projectId && cancelAutoResume(projectId, task)}>
                  Cancel schedule
                </button>
              </div>
            )}
            {run.status === 'paused' && run.pauseKind !== 'needsUser' && (
              <form
                className="auto-schedule-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  try {
                    if (projectId)
                      scheduleAutoResume(projectId, task, new Date(resumeTime).getTime())
                    setScheduleError(undefined)
                    setError('')
                  } catch (e) {
                    setScheduleError({ key: scheduleKey, message: String(e) })
                  }
                }}
              >
                <label>
                  Resume at ({Intl.DateTimeFormat().resolvedOptions().timeZone})
                  <input
                    type="datetime-local"
                    required
                    value={resumeTime}
                    onChange={(e) => setResumeTime(e.target.value)}
                  />
                </label>
                <button type="submit">
                  {run.resumeTrigger ? 'Change schedule' : 'Schedule resume'}
                </button>
                {scheduleError?.key === scheduleKey && (
                  <p className="auto-callout" data-tone="bad" role="alert">
                    {scheduleError.message}
                  </p>
                )}
              </form>
            )}
          </section>
        )}
        <PanelDetails title="Activity and details">
          <dl className="auto-values">
            {run.round > 0 && (
              <>
                <dt>Fix rounds</dt>
                <dd>{run.round}</dd>
              </>
            )}
            {run.validation?.some((r) => r.results.length) && (
              <>
                <dt>Validation</dt>
                <dd>{validationSummary(run.validation)}</dd>
              </>
            )}
            <dt>{run.baseCommit ? 'In place' : 'Merge into'}</dt>
            <dd>
              {run.baseCommit
                ? `Reviewing against ${shortSha(run.baseCommit)}, no merge`
                : run.merge.destinationBranch}
            </dd>
            <dt>Fix round limit</dt>
            <dd>{effortSettings(run).maxRounds}</dd>
          </dl>
          <ol className="auto-log">
            {[...run.log].reverse().map((l, i) => (
              <li key={run.log.length - 1 - i}>
                <time>{new Date(l.atMs).toLocaleTimeString()}</time>
                <span>{l.text}</span>
              </li>
            ))}
          </ol>
        </PanelDetails>
      </div>
      {powerSection}
    </PanelContent>
  )
}

const STATUS_TONES: Record<AutoRun['status'], string> = {
  running: 'running',
  paused: 'attention',
  waitingOnYou: 'attention',
  failed: 'bad',
  done: 'ok',
  stopped: '',
}

/** How the stepper marks the run's stage, so a paused, failed or stopped run doesn't look active. */
const CURRENT_STEP_STATES: Record<AutoRun['status'], string> = {
  running: 'current',
  paused: 'attention',
  waitingOnYou: 'attention',
  failed: 'failed',
  done: 'done',
  stopped: 'stopped',
}

/** The stepper stage a run is on: fixing is implementing again, and the gate belongs to merge. */
function currentStep(run: AutoRun) {
  if (run.stage === 'fix') return 'implement'
  if (run.stage === 'mergeGate' || run.stage === 'done') return inPlace(run) ? 'review' : 'merge'
  return run.stage
}

/** The run's latest review verdict at a glance, with a way to read it in Review. */
function AutoFindings({
  projectId,
  branch,
  refresh,
}: {
  projectId: string | undefined
  branch: string
  /** Changes as the run moves on, so the verdict follows the findings Auto just judged. */
  refresh: string
}) {
  const loaded = useReviewFindings(projectId, branch, false, refresh)
  // Review shows the worktree's checked-out branch, which may no longer be the run's.
  const checkedOut = useStore((s) => activeTaskOf(s)?.branch)
  const running = useRunningReviewLanes(branch)
  const findings = loaded?.findings
  return (
    <div className="auto-findings">
      <span>Review:</span>
      <VerdictBadge findings={findings} running={running} />
      <SeverityCounts findings={findings} />
      {(!checkedOut || checkedOut === branch) && (
        <button
          onClick={() => {
            useStore.setState({ reviewFindingsFocus: true })
            useStore.getState().setView('review')
          }}
        >
          View findings
        </button>
      )}
    </div>
  )
}
