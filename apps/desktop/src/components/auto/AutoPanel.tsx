import { setAutoKeepAwake, useAutoPower } from '../../lib/autoPower'
import { logSimple } from '../../lib/simpleActions'
import { simpleStageOf, type SimpleAction } from '../../lib/simple'
import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { parseSessionId, type ActionReport, type AutoRun } from '../../types'
import {
  autoRun,
  cancelAutoResume,
  scheduleAutoResume,
  setAutoUsageResume,
  effortSettings,
  inPlace,
  mergeNow,
  pauseAuto,
  resumeAuto,
  resumeAutoWithAgent,
  skipStage,
  stopAuto,
} from '../../lib/auto'
import { revealTerminal } from '../../lib/attention'
import { useClockNow } from '../../lib/clock'
import { agentDevices } from '../../lib/plan'
import { presetExhausted, useUsage } from '../../lib/usage'
import AutoDialog from './AutoDialog'
import type { HookProvider } from '../../lib/agentHooks'
import {
  returnAfterAutoStop,
  workError,
  worktreeLabel,
  worktreeIdentity,
} from '../../lib/workBlocker'
import Dialog from '../Dialog'
import { autoDraftKey, autoDrafts, replacementAutoDraft } from '../../lib/autoDrafts'
import { finished as ended, STATUS_LABELS, taskPassed } from '../../lib/autoSettings'
import PanelContent from '../PanelContent'
import { PanelDetails } from '../PanelSection'
import { SeverityCounts, VerdictBadge } from '../findings/FindingsPanel'
import { useRunningReviewLanes } from '../../lib/reviewAgents'
import { useReviewFindings } from '../../lib/useReviewFindings'
import { activeTaskOf } from '../../lib/tasks'
import { shortSha } from '../../lib/commitId'
import { autoStepper } from '../../lib/stageModel'
import { useStageModel } from '../../lib/useStageModel'
import StageStrip from '../StageStrip'
import './auto.css'

function validationSummary(reports: ActionReport[]) {
  const checks = reports.flatMap((report) => report.results)
  if (!checks.length) return 'No checks ran'
  const failed = checks.filter((check) => !taskPassed(check)).length
  if (failed) return `${failed} of ${checks.length} checks did not pass`
  return `${checks.length} ${checks.length === 1 ? 'check' : 'checks'} passed`
}

const POWER_PROBLEMS: Partial<Record<string, string>> = {
  onBattery: 'On battery: scheduled work may wait until the device wakes.',
  powerUnknown: 'Power source unknown: sleep prevention is inactive.',
  unavailable: 'Sleep prevention unavailable.',
}

/** After a usage pause: continue now on a preset whose subscription still has usage. */
function ResumeOnAgent({
  disabled,
  onChoose,
}: {
  disabled: boolean
  onChoose: (device: string) => void
}) {
  const devices = useStore((s) => s.devices)
  const usage = useUsage((s) => s.usage)
  const presets = agentDevices(devices)
  const now = useClockNow(
    presets.flatMap((preset) => presetExhausted(usage, preset, 0)).map((w) => w.window.resetsAtMs),
  )
  return (
    <label>
      Continue with another agent
      <select
        value=""
        disabled={disabled}
        onChange={(e) => e.target.value && onChoose(e.target.value)}
      >
        <option value="" disabled>
          Choose an agent…
        </option>
        {presets.map((device) => (
          <option
            value={device.id}
            key={device.id}
            disabled={presetExhausted(usage, device, now).length > 0}
          >
            {device.name}
          </option>
        ))}
      </select>
    </label>
  )
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
  // The worktree's shared stage model, which also covers work after this run ended.
  const stage = useStageModel()
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const draftVersion = useStore((s) => s.autoDraftVersion)
  const [error, setError] = useState('')
  const [stopRequest, setStopRequest] = useState<{
    run: AutoRun
    tree?: string
    configure: boolean
  }>()
  const [stopping, setStopping] = useState(false)
  // The stopped run whose replacement setup should take focus once, not every later setup.
  const [focusSetupFor, setFocusSetupFor] = useState<string>()
  const draftKey = autoDraftKey(projectId, task)
  const savedDraft = autoDrafts.get(draftKey)
  // Tied to the run and pause it came from, so a later pause or another worktree starts clean.
  const [scheduleError, setScheduleError] = useState<{ key: string; message: string }>()
  const [resumeTime, setResumeTime] = useState('')
  // The finished run New run was pressed for; another run or worktree shows its own state.
  const [newRunFor, setNewRunFor] = useState<string | null>(null)
  const finished = !!run && ended(run.status)
  const newRun =
    finished &&
    (newRunFor === JSON.stringify([projectId, task, run.runId]) ||
      !!savedDraft?.story ||
      savedDraft?.replacementFor === run.runId)
  // Run controls whose call is in flight, so a second press can't send one twice. Controls that
  // advance the run (merge, resume, skip) exclude each other; Pause and Stop stay available so
  // they can still cancel a slow Resume.
  const [pending, setPending] = useState<ReadonlySet<SimpleAction>>(new Set())
  const advancing = (['mergeApproval', 'resumeAuto', 'skipStage'] as SimpleAction[]).some((a) =>
    pending.has(a),
  )
  const blocked = (action: SimpleAction) =>
    pending.has(action) ||
    (advancing && ['mergeApproval', 'resumeAuto', 'skipStage'].includes(action))
  const act = (
    action: SimpleAction,
    fn: (id: string, task: string | null) => void | Promise<void>,
  ) => {
    if (!projectId || blocked(action) || stopping) return
    setPending((current) => new Set(current).add(action))
    void Promise.resolve()
      .then(() => fn(projectId, task))
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
      .finally(() =>
        setPending((current) => {
          const next = new Set(current)
          next.delete(action)
          return next
        }),
      )
  }
  // Opens Power when sleep prevention can't do its job, so the warning isn't left collapsed.
  const chooseStop = (configure: boolean) => {
    if (!projectId || !run) return
    setError('')
    setStopRequest({ run, tree: worktreeIdentity({ projectId, task }), configure })
  }
  const confirmStop = async () => {
    if (!projectId || !stopRequest || stopping) return
    const target = { projectId, task }
    const currentScope = () => {
      const state = useStore.getState()
      return (
        !!stopRequest.tree &&
        state.project?.id === projectId &&
        state.activeTask === task &&
        worktreeIdentity(target) === stopRequest.tree
      )
    }
    setStopping(true)
    try {
      if (!currentScope())
        throw new Error('The worktree changed. Open the intended Auto run and try again.')
      await stopAuto(projectId, task, stopRequest.run, { replace: stopRequest.configure })
      const stopped = autoRun(projectId, task)
      if (simple)
        logSimple(projectId, task, {
          kind: 'action',
          action: 'stopAuto',
          stage: simpleStageOf(stopRequest.run.stage),
        })
      if (stopRequest.configure && stopped?.status === 'stopped') {
        autoDrafts.set(draftKey, replacementAutoDraft(stopRequest.run, stopped.runId))
        if (currentScope()) setFocusSetupFor(stopped.runId)
      } else {
        returnAfterAutoStop(target, stopRequest.run)
        requestAnimationFrame(() => {
          if (document.activeElement === document.body)
            document.querySelector<HTMLButtonElement>('[data-auto-new-run]')?.focus()
        })
      }
    } catch (e) {
      setError(workError(e).message)
    } finally {
      setStopping(false)
      setStopRequest(undefined)
    }
  }
  // The setup dialog took focus on mount; a later remount of it must not take focus again.
  const settingUp = !run || (newRun && !stopRequest)
  useEffect(() => {
    if (focusSetupFor && settingUp) setFocusSetupFor(undefined)
  }, [focusSetupFor, settingUp])
  const powerProblem =
    keepAwake &&
    (['onBattery', 'powerUnknown', 'unavailable'].includes(power.status) || !!power.error)
  const powerSection = (
    <PanelDetails title="Power" reveal={powerProblem}>
      <label className="auto-check auto-toggle" data-power={keepAwake ? power.status : undefined}>
        <input
          type="checkbox"
          role="switch"
          checked={keepAwake}
          onChange={(e) => setAutoKeepAwake(e.target.checked)}
        />
        Keep awake while plugged in
      </label>
      <p className="auto-hint">
        Keep Patchbay open. The screen can turn off. This setting cannot wake a sleeping device.
      </p>
      {powerProblem && (
        <p role="status" className="auto-hint">
          {POWER_PROBLEMS[power.status] ?? 'Sleep prevention error.'}
          {power.error && ` ${power.error}`}
        </p>
      )}
    </PanelDetails>
  )
  if (settingUp)
    return (
      <PanelContent>
        <AutoDialog
          key={`${autoDraftKey(projectId, task)}/${draftVersion}`}
          onIntegrations={onIntegrations}
          simple={simple}
          focusGoal={!!run && focusSetupFor === run.runId}
        />
        {powerSection}
      </PanelContent>
    )
  // A run that later work superseded shows that work, as Chat does; otherwise the run's stages.
  const superseded = !!stage && !stage.autoCurrent
  const stages = superseded ? stage.stepper : autoStepper(run)
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
        <StageStrip items={stages} label={superseded ? 'Current work stages' : 'Run stages'} />
        {superseded && (
          <p className="auto-hint" role="status">
            Work continued after this run; the stages show the worktree’s current work.
          </p>
        )}
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
            <button
              className="primary"
              disabled={blocked('mergeApproval')}
              onClick={() => act('mergeApproval', mergeNow)}
            >
              Merge now
            </button>
          )}
          {run.status === 'running' ? (
            <button disabled={blocked('pauseAuto')} onClick={() => act('pauseAuto', pauseAuto)}>
              Pause
            </button>
          ) : (
            stoppable && (
              <button
                className={
                  run.stage === 'mergeGate' && run.status === 'waitingOnYou' ? undefined : 'primary'
                }
                disabled={blocked('resumeAuto') || stopping}
                onClick={() => act('resumeAuto', (id, task) => resumeAuto(id, task))}
              >
                {run.resumeTrigger ? 'Resume now' : 'Resume'}
              </button>
            )
          )}
          {finished && (
            <button
              data-auto-new-run
              className={run.status === 'failed' ? undefined : 'primary'}
              onClick={() => setNewRunFor(JSON.stringify([projectId, task, run.runId]))}
            >
              New run
            </button>
          )}
          {['paused', 'failed', 'waitingOnYou'].includes(run.status) && (
            <button
              disabled={blocked('skipStage') || stopping}
              onClick={() => act('skipStage', skipStage)}
            >
              {run.stage === 'scan' ? 'Continue with available findings' : 'Skip stage'}
            </button>
          )}
          {run.status === 'paused' && (
            <button disabled={stopping} onClick={() => chooseStop(true)}>
              Stop and configure new run
            </button>
          )}
          {stoppable && (
            <button
              className="auto-stop"
              disabled={blocked('stopAuto') || stopping}
              onClick={() => chooseStop(false)}
            >
              Stop
            </button>
          )}
        </div>
        {stopRequest && projectId && (
          <Dialog
            title={stopRequest.configure ? 'Stop and configure new run' : 'Stop Auto run'}
            className="centered confirm-dialog"
            onClose={() => setStopRequest(undefined)}
            dismissible={!stopping}
            footer={
              <>
                <button autoFocus onClick={() => setStopRequest(undefined)} disabled={stopping}>
                  Cancel
                </button>
                <button className="danger" onClick={() => void confirmStop()} disabled={stopping}>
                  {stopping ? 'Stopping Auto…' : 'Stop run'}
                </button>
              </>
            }
          >
            <p>
              Stop “{stopRequest.run.goal}” in {worktreeLabel({ projectId, task })}? This can end
              the agents Auto launched.
            </p>
            {stopRequest.configure && (
              <p>
                The replacement starts with zero fix rounds used. Review the setup and press Start
                when ready.
              </p>
            )}
          </Dialog>
        )}
        {error && (
          <p className="auto-callout" data-tone="bad" role="alert">
            {error}
          </p>
        )}
        {(!finished || run.resumeTrigger) && (
          <section className="auto-group" aria-label="Resume">
            {run.status === 'paused' && run.pauseKind === 'usage' && (
              <ResumeOnAgent
                disabled={blocked('resumeAuto') || stopping}
                onChoose={(device) =>
                  act('resumeAuto', (id, task) => resumeAutoWithAgent(id, task, device))
                }
              />
            )}
            {!finished && (
              <label className="auto-toggle">
                <input
                  type="checkbox"
                  role="switch"
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
