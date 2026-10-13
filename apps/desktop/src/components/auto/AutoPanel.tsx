import { useState } from 'react'
import { useStore } from '../../store'
import { parseSessionId } from '../../types'
import {
  effortSettings,
  mergeNow,
  pauseAuto,
  resumeAuto,
  skipStage,
  stopAuto,
  STAGES,
  STAGE_LABELS,
} from '../../lib/auto'
import { revealTerminal } from '../../lib/attention'
import AutoDialog from './AutoDialog'
import Popover from '../Popover'
import './auto.css'

export default function AutoPanel({ onIntegrations }: { onIntegrations: () => void }) {
  const run = useStore((s) => s.auto)
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const [error, setError] = useState('')
  const [newRun, setNewRun] = useState(false)
  const label = !run
    ? 'Auto'
    : run.status === 'running'
      ? `Auto · ${STAGE_LABELS[run.stage]} · ${run.round}/${effortSettings(run).maxRounds}`
      : `Auto · ${run.status === 'waitingOnYou' ? 'Waiting on you' : run.status}`
  const act = (fn: (id: string, task: string | null) => void | Promise<void>) => {
    if (projectId) void Promise.resolve(fn(projectId, task)).catch((e) => setError(String(e)))
  }
  return (
    <Popover
      className="auto-menu"
      label={label}
      align="right"
      title="Auto mode"
      portal
      listClassName="auto-popover"
    >
      {!run || (newRun && ['done', 'stopped', 'failed'].includes(run.status)) ? (
        <AutoDialog onIntegrations={onIntegrations} />
      ) : (
        <div className="auto-content">
          <strong>Auto mode · {run.status}</strong>
          <p>{run.goal}</p>
          <ol className="auto-stages">
            {STAGES.map((stage) => (
              <li key={stage} aria-current={run.stage === stage ? 'step' : undefined}>
                {STAGE_LABELS[stage]}
              </li>
            ))}
          </ol>
          <p>
            Fix rounds: {run.round}/{effortSettings(run).maxRounds} · Merge into{' '}
            {run.merge.destinationBranch}
          </p>
          {run.reason && <p>{run.reason}</p>}
          {run.findingsSummary && ['mergeGate', 'fix'].includes(run.stage) && (
            <details>
              <summary>Review summary</summary>
              <p>{run.findingsSummary}</p>
            </details>
          )}
          {run.validation && (
            <p>
              Validation: {run.validation.length} report(s),{' '}
              {
                run.validation.filter(
                  (r) => r.results.some((x) => x.outcome === 'failed') || r.plan.skipped.length > 0,
                ).length
              }{' '}
              need attention
            </p>
          )}
          {run.sessionId && (
            <button
              onClick={() =>
                revealTerminal({
                  sid: run.sessionId!,
                  componentId: parseSessionId(run.sessionId!).componentId,
                })
              }
            >
              Open current session
            </button>
          )}
          <div className="auto-controls">
            {run.status === 'running' ? (
              <button onClick={() => act(pauseAuto)}>Pause</button>
            ) : (
              !['done', 'stopped'].includes(run.status) && (
                <button onClick={() => act(resumeAuto)}>Resume</button>
              )
            )}
            {!['done', 'stopped'].includes(run.status) && (
              <button onClick={() => act(stopAuto)}>Stop</button>
            )}
            {['paused', 'failed', 'waitingOnYou'].includes(run.status) && (
              <button onClick={() => act(skipStage)}>Skip stage</button>
            )}
            {run.stage === 'mergeGate' && run.status === 'waitingOnYou' && (
              <button onClick={() => act(mergeNow)}>Merge now</button>
            )}
            {['done', 'stopped', 'failed'].includes(run.status) && (
              <button onClick={() => setNewRun(true)}>New run</button>
            )}
          </div>
          {error && <p role="alert">{error}</p>}
          <ol className="auto-log">
            {run.log.map((l, i) => (
              <li key={`${l.atMs}-${i}`}>
                <time>{new Date(l.atMs).toLocaleTimeString()}</time> {l.text}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Popover>
  )
}
