import { useStore } from '../store'
import { controlTeam, RESTART_NOTICE, useChatTeams, type ChatTeam } from '../lib/chatTeams'
import type { ScanReport } from '../lib/orchestration'
import { selectPanel, useRail } from '../lib/rail'
import { useState } from 'react'
import type { SessionRecord } from '../types'
import { activityLabel, turnSteps } from '../lib/activity'
import { teamJobs, workerCounts, workerSession, workerStatus } from '../lib/chatProgress'

/** Only coordination status and actionable exceptions belong beside the lead conversation. */
export default function ChatCoordination({
  team,
  openTerminal,
}: {
  team: ChatTeam
  openTerminal: (record: SessionRecord) => void
}) {
  const runs = useChatTeams((s) => s.runs[team.projectId])
  const sessions = useStore((s) => s.sessions)
  const records = useStore((s) => s.sessionRecords)
  const jobs = teamJobs(runs ?? [], team.id)
  const counts = workerCounts(jobs, sessions)
  const active = jobs.filter((job) => workerStatus(job, sessions) !== 'complete')
  const terminalAction = (job: (typeof jobs)[number]) => {
    const record = workerSession(job, records, team.projectId)
    return (
      <button disabled={!record} onClick={() => record && openTerminal(record)}>
        View worker terminal
      </button>
    )
  }
  const workerStep = (job: (typeof jobs)[number]) => {
    const step = job.sessionId ? turnSteps(sessions[job.sessionId]).at(-1) : undefined
    return step && activityLabel(step, workerSession(job, records, team.projectId)?.spec.cwd)
  }
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const act = async (control: Parameters<typeof controlTeam>[1]) => {
    setBusy(true)
    setError('')
    try {
      await controlTeam(team, control)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  // The restart notice is informational; it replaces "Paused" instead of raising an alert.
  const restartNotice = team.error === RESTART_NOTICE
  const failed = (j: (typeof jobs)[number]) =>
    j.state === 'failed' || (j.state === 'launching' && !!j.error)
  const rank = (job: (typeof jobs)[number]) =>
    workerStatus(job, sessions) === 'complete' ? 2 : failed(job) ? 1 : 0
  const asking = jobs.filter((j) => workerStatus(j, sessions) === 'awaiting input')
  const failures = jobs.filter(failed)
  // Problems open the list so a failure is never hidden behind a closed disclosure.
  const urgent = [...failures, ...asking].map((job) => job.id).join(' ')
  const [open, setOpen] = useState(!!urgent)
  const [seenUrgent, setSeenUrgent] = useState(urgent)
  if (urgent !== seenUrgent) {
    setSeenUrgent(urgent)
    if (urgent) setOpen(true)
  }
  const flagged = [
    failures.length && `${failures.length} failed`,
    asking.length && `${asking.length} awaiting input`,
  ].filter(Boolean)
  return (
    <div className="chat-coordination" aria-label="Work status">
      <p role="status">
        {team.state === 'running'
          ? active.length
            ? Object.entries(counts)
                .filter(([, count]) => count > 0)
                .map(([status, count]) => `${count} ${status}`)
                .join(' · ')
            : 'Ready'
          : team.state === 'paused'
            ? restartNotice
              ? RESTART_NOTICE
              : 'Paused'
            : team.state === 'stopped'
              ? 'Stopped'
              : 'Complete'}
      </p>
      {failures.map((job) => (
        <p role="alert" key={job.id}>
          {job.terminal.name} · failed{' '}
          <button disabled={busy} onClick={() => void act({ kind: 'retry', assignment: job.id })}>
            Retry work
          </button>
          <button onClick={() => useRail.setState({ settings: 'roles' })}>Agent settings</button>
        </p>
      ))}
      {asking.map((job) => (
        <p role="alert" key={job.id}>
          {job.terminal.name} · awaiting input {terminalAction(job)}
        </p>
      ))}
      {jobs.length > 0 && (
        <details
          className="chat-workers"
          open={open}
          onToggle={(e) => setOpen(e.currentTarget.open)}
        >
          <summary>
            Assignments ({jobs.length})
            {flagged.length > 0 && (
              <span className="chat-workers-flag"> · {flagged.join(' · ')}</span>
            )}
          </summary>
          <ul>
            {jobs
              .sort((a, b) => rank(a) - rank(b))
              .map((job) => {
                const status = workerStatus(job, sessions)
                const step = workerStep(job)
                const done = status === 'complete'
                return (
                  <li key={job.id} data-status={failed(job) ? 'failed' : status}>
                    <strong>{job.terminal.name}</strong> · {status}
                    {step && <> · {step}</>}
                    {job.summary && <p>{job.summary}</p>}
                    {!(done && job.summary) && (
                      <p className="assignment-instructions" title={job.instructions}>
                        {job.instructions}
                      </p>
                    )}
                    {job.report && <AssignmentReport report={job.report} />}
                    {job.error && <p>{job.error}</p>}
                    {terminalAction(job)}
                    {failed(job) && (
                      <button
                        disabled={busy}
                        onClick={() => void act({ kind: 'retry', assignment: job.id })}
                      >
                        Retry work
                      </button>
                    )}
                  </li>
                )
              })}
          </ul>
          <button onClick={() => selectPanel('sessions')}>Open Sessions</button>
        </details>
      )}
      {team.reset && <p role="status">{team.reset.error ?? 'Restoring context…'}</p>}
      {team.error && !restartNotice && <p role="alert">{team.error}</p>}
      {(team.requests ?? [])
        .filter((r) => ['failed', 'uncertain'].includes(r.state))
        .map((r) => (
          <p role="alert" key={r.id}>
            {r.result ?? `${r.action} ${r.state}`}{' '}
            <button onClick={() => selectPanel('sessions')}>Inspect Sessions</button>
            <button onClick={() => useRail.setState({ settings: 'roles' })}>Agent settings</button>
          </p>
        ))}
      {team.messages
        .filter((m) => m.state === 'uncertain')
        .map((m) => (
          <div role="alert" key={m.id}>
            Message delivery was not confirmed. Inspect the recipient’s terminal before retrying.{' '}
            <button onClick={() => selectPanel('sessions')}>Open Sessions</button>
            <button
              disabled={busy}
              onClick={() => void act({ kind: 'resolveDelivery', id: m.id, delivered: true })}
            >
              Mark delivered
            </button>
            <button
              disabled={busy}
              onClick={() => void act({ kind: 'resolveDelivery', id: m.id, delivered: false })}
            >
              Retry delivery
            </button>
          </div>
        ))}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}

const REPORT_FIELDS: [keyof Omit<ScanReport, 'references'>, string][] = [
  ['findings', 'Findings'],
  ['uncertainties', 'Uncertainties'],
  ['suggestedWork', 'Suggested work'],
]

/** A finished assignment's report, read as labelled sections rather than raw data. */
function AssignmentReport({ report }: { report: ScanReport }) {
  return (
    <details className="assignment-report">
      <summary>Report</summary>
      <dl>
        {REPORT_FIELDS.filter(([field]) => report[field].trim()).map(([field, label]) => (
          <div key={field}>
            <dt>{label}</dt>
            <dd>{report[field]}</dd>
          </div>
        ))}
        {report.references.length > 0 && (
          <div>
            <dt>References</dt>
            <dd>{report.references.join('\n')}</dd>
          </div>
        )}
      </dl>
    </details>
  )
}
