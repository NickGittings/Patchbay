import { logSimple } from '../../lib/simpleActions'
import { simpleStageOf, type SimpleAction } from '../../lib/simple'
import { useState } from 'react'
import { useStore } from '../../store'
import { parseSessionId, type ActionReport } from '../../types'
import {
  effortSettings,
  mergeNow,
  pauseAuto,
  resumeAuto,
  skipStage,
  stopAuto,
  STAGE_LABELS,
} from '../../lib/auto'
import { revealTerminal } from '../../lib/attention'
import AutoDialog from './AutoDialog'
import { autoDraftKey } from '../../lib/autoDrafts'
import { finished as ended, STATUS_LABELS, taskPassed } from '../../lib/autoSettings'
import Popover from '../Popover'
import { SeverityCounts, VerdictBadge } from '../findings/FindingsPanel'
import { useRunningReviewLanes } from '../../lib/reviewAgents'
import { useReviewFindings } from '../../lib/useReviewFindings'
import { activeTaskOf } from '../../lib/tasks'
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
  onIntegrations: () => void
  simple?: boolean
}) {
  const run = useStore((s) => s.auto)
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const openRequest = useStore((s) => s.autoPanelRequest)
  const [error, setError] = useState('')
  // The finished run New run was pressed for; another run or worktree shows its own state.
  const [newRunFor, setNewRunFor] = useState<string | null>(null)
  const finished = !!run && ended(run.status)
  const newRun = finished && newRunFor === JSON.stringify([projectId, task, run.runId])
  const label = !run
    ? 'Auto'
    : run.status === 'running'
      ? `Auto: ${STAGE_LABELS[run.stage]}`
      : `Auto: ${STATUS_LABELS[run.status]}`
  const act = (
    action: SimpleAction,
    fn: (id: string, task: string | null) => void | Promise<void>,
  ) => {
    if (projectId)
      void Promise.resolve(fn(projectId, task))
        .then(() => {
          if (simple)
            logSimple(projectId, task, {
              kind: 'action',
              action,
              stage: simpleStageOf(run?.stage),
              sessionId: run?.sessionId,
            })
        })
        .catch((e) => setError(String(e)))
  }
  return (
    <Popover
      className="auto-menu"
      label={label}
      caret={false}
      align="right"
      title="Auto mode"
      portal
      listClassName="auto-popover"
      openRequest={openRequest}
    >
      {!run || newRun ? (
        <AutoDialog
          key={autoDraftKey(projectId, task)}
          onIntegrations={onIntegrations}
          simple={simple}
        />
      ) : (
        <div className="auto-content">
          <strong>Auto mode: {STATUS_LABELS[run.status]}</strong>
          <p>{run.goal}</p>
          <p>Current stage: {STAGE_LABELS[run.stage]}</p>
          {run.reason && run.status !== 'running' && <p>{run.reason}</p>}
          {run.gateError && <p role="status">Couldn't check merge status: {run.gateError}</p>}
          {run.branch && ['review', 'fix', 'mergeGate', 'merge', 'done'].includes(run.stage) && (
            <AutoFindings
              projectId={projectId}
              branch={run.branch}
              refresh={`${run.stage}:${run.status}:${run.log.length}`}
            />
          )}
          {run.round > 0 && <p>Fix rounds: {run.round}</p>}
          {run.validation && <p>Validation: {validationSummary(run.validation)}</p>}
          {run.sessionId && (
            <button
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
          <div className="auto-controls">
            {run.status === 'running' ? (
              <button onClick={() => act('pauseAuto', pauseAuto)}>Pause</button>
            ) : (
              !['done', 'stopped'].includes(run.status) && (
                <button onClick={() => act('resumeAuto', resumeAuto)}>Resume</button>
              )
            )}
            {!['done', 'stopped'].includes(run.status) && (
              <button onClick={() => act('stopAuto', stopAuto)}>Stop</button>
            )}
            {['paused', 'failed', 'waitingOnYou'].includes(run.status) && (
              <button onClick={() => act('skipStage', skipStage)}>Skip stage</button>
            )}
            {run.stage === 'mergeGate' && run.status === 'waitingOnYou' && (
              <button onClick={() => act('mergeApproval', mergeNow)}>Merge now</button>
            )}
            {finished && (
              <button onClick={() => setNewRunFor(JSON.stringify([projectId, task, run.runId]))}>
                New run
              </button>
            )}
          </div>
          {error && <p role="alert">{error}</p>}
          <details>
            <summary>Activity and details</summary>
            <p>Merge into: {run.merge.destinationBranch}</p>
            <p>Fix round limit: {effortSettings(run).maxRounds}</p>
            {run.reason && run.status === 'running' && <p>{run.reason}</p>}
            <ol className="auto-log">
              {[...run.log].reverse().map((l, i) => (
                <li key={`${l.atMs}-${i}`}>
                  <time>{new Date(l.atMs).toLocaleTimeString()}</time> {l.text}
                </li>
              ))}
            </ol>
          </details>
        </div>
      )}
    </Popover>
  )
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
  if (!findings?.verdict) return null
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
