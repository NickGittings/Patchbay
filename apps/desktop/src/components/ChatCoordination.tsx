import { useStore } from '../store'
import {
  controlTeam,
  RESTART_NOTICE,
  retryOnAgent,
  useChatTeams,
  type ChatTeam,
} from '../lib/chatTeams'
import { useClockNow } from '../lib/clock'
import { planTerminals } from '../lib/plan'
import { simpleKey, useSimpleUi } from '../lib/simpleUi'
import { presetExhausted, useUsage } from '../lib/usage'
import type { ProviderJob, ScanReport } from '../lib/orchestration'
import { selectPanel, useRail } from '../lib/rail'
import Popover from './Popover'
import { CloseMenu } from './menuContext'
import { useContext, useEffect, useRef, useState } from 'react'
import type { SessionRecord } from '../types'
import { activityLabel, turnSteps } from '../lib/activity'
import { teamJobs, workerCounts, workerSession, workerStatus } from '../lib/chatProgress'

type Props = { team: ChatTeam; openTerminal: (record: SessionRecord) => void }

/** A job's current result: a retry or a new failure is a new result, so it shows again. */
const dismissalKey = (job: ProviderJob) => JSON.stringify([job.requestId, job.state, job.error])
const failed = (job: ProviderJob) =>
  job.state === 'failed' || (job.state === 'launching' && !!job.error)
const showSettings = () => useRail.setState({ settings: 'roles' })
const showSessions = () => selectPanel('sessions')

/** The team's assignments, split by whether the user dismissed their current result. */
function useTeamWork(team: ChatTeam) {
  const runs = useChatTeams((s) => s.runs[team.projectId])
  const sessions = useStore((s) => s.sessions)
  const key = simpleKey(team.projectId, team.task)
  const dismissedKeys = useSimpleUi((s) => s.worktrees[key]?.dismissedAssignments)
  const allJobs = teamJobs(runs ?? [], team.id)
  const isDismissed = (job: ProviderJob) => !!dismissedKeys?.includes(dismissalKey(job))
  const jobs = allJobs.filter((job) => !isDismissed(job))
  const restartNotice = team.error === RESTART_NOTICE
  const issues = {
    teamError: !!team.error && !restartNotice,
    requests: (team.requests ?? []).filter((r) => ['failed', 'uncertain'].includes(r.state)),
    messages: team.messages.filter((m) => m.state === 'uncertain'),
  }
  // Reads the store at click time, so quick successive dismissals never overwrite each other,
  // and keeps only keys for current results, so the persisted list cannot grow without bound.
  const setDismissed = (job: ProviderJob, dismissed: boolean) => {
    const ui = useSimpleUi.getState()
    const live = new Set(allJobs.map(dismissalKey))
    const id = dismissalKey(job)
    const kept = (ui.worktrees[key]?.dismissedAssignments ?? []).filter(
      (k) => live.has(k) && k !== id,
    )
    ui.patch(key, { dismissedAssignments: dismissed ? [...kept, id] : kept })
  }
  return {
    sessions,
    allJobs,
    jobs,
    dismissed: allJobs.filter(isDismissed),
    failures: jobs.filter(failed),
    asking: jobs.filter((job) => workerStatus(job, sessions) === 'awaiting input'),
    restartNotice,
    issues,
    setDismissed,
  }
}

function useTeamAction(team: ChatTeam) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const act = (control: Parameters<typeof controlTeam>[1]) => run(() => controlTeam(team, control))
  return { act, run, busy, error }
}

/** Offers the other agent presets for a failed assignment. */
function RetryOnAgent({
  team,
  job,
  busy,
  run,
}: {
  team: ChatTeam
  job: ProviderJob
  busy: boolean
  run: (action: () => Promise<unknown>) => Promise<void>
}) {
  const devices = useStore((s) => s.devices)
  const usage = useUsage((s) => s.usage)
  const presets = planTerminals(devices).filter((t) => t.command !== job.terminal.command)
  const now = useClockNow(
    presets.flatMap((t) => presetExhausted(usage, t, 0)).map((w) => w.window.resetsAtMs),
  )
  if (job.state !== 'failed' || !presets.length) return null
  return (
    <select
      aria-label={`Retry ${job.terminal.name} on another agent`}
      value=""
      disabled={busy}
      onChange={(e) => {
        const terminal = presets.find((t) => t.id === e.target.value)
        if (terminal) void run(() => retryOnAgent(team, job.id, terminal))
      }}
    >
      <option value="" disabled>
        Retry with…
      </option>
      {presets.map((t) => (
        <option value={t.id} key={t.id} disabled={presetExhausted(usage, t, now).length > 0}>
          {t.name}
        </option>
      ))}
    </select>
  )
}

/**
 * Problems that need the user, shown in the chat itself and announced as they appear: failed and
 * input-waiting workers, coordination errors and unconfirmed deliveries. Routine status stays in
 * the composer's Assignments popover.
 */
export function ChatCoordinationAlerts({ team, openTerminal }: Props) {
  const records = useStore((s) => s.sessionRecords)
  const work = useTeamWork(team)
  const { act, run, busy, error } = useTeamAction(team)
  const { teamError, requests, messages } = work.issues
  const terminal = (job: ProviderJob) => workerSession(job, records, team.projectId)
  if (
    !work.failures.length &&
    !work.asking.length &&
    !teamError &&
    !team.reset?.error &&
    !requests.length &&
    !messages.length &&
    !error
  )
    return null
  return (
    <div className="chat-coordination" aria-label="Work alerts">
      {work.failures.map((job) => (
        <p role="alert" key={job.id}>
          {job.terminal.name} · failed{job.error && <> · {job.error}</>}{' '}
          <button disabled={busy} onClick={() => void act({ kind: 'retry', assignment: job.id })}>
            Retry work
          </button>
          <RetryOnAgent team={team} job={job} busy={busy} run={run} />
          <button onClick={showSettings}>Agent settings</button>
        </p>
      ))}
      {work.asking.map((job) => {
        const record = terminal(job)
        return (
          <p role="alert" key={job.id}>
            {job.terminal.name} · awaiting input{' '}
            <button disabled={!record} onClick={() => record && openTerminal(record)}>
              View worker terminal
            </button>
          </p>
        )
      })}
      {team.reset?.error && <p role="alert">{team.reset.error}</p>}
      {teamError && <p role="alert">{team.error}</p>}
      {requests.map((r) => (
        <p role="alert" key={r.id}>
          {r.result ?? `${r.action} ${r.state}`}{' '}
          <button onClick={showSessions}>Open Sessions</button>
          <button onClick={showSettings}>Agent settings</button>
        </p>
      ))}
      {messages.map((m) => (
        <div role="alert" key={m.id}>
          Message delivery was not confirmed. Inspect the recipient’s terminal before retrying.{' '}
          <button onClick={showSessions}>Open Sessions</button>
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

/**
 * The composer's Assignments button and its anchored, non-blocking popover. The button names how
 * many items need the user; the alerts above the composer carry the details and recovery actions.
 */
export default function ChatCoordination(props: Props) {
  const work = useTeamWork(props.team)
  const { teamError, requests, messages } = work.issues
  const coordination =
    Number(teamError) + Number(!!props.team.reset?.error) + requests.length + messages.length
  const flagged = work.failures.length + work.asking.length + coordination
  const details = [
    work.failures.length && `${work.failures.length} failed`,
    work.asking.length && `${work.asking.length} awaiting input`,
    coordination && `${coordination} coordination ${coordination === 1 ? 'issue' : 'issues'}`,
  ].filter(Boolean)
  return (
    <Popover
      portal
      above
      align="right"
      caret={false}
      title="Assignments"
      triggerLabel={[`Assignments, ${work.jobs.length}`, ...details].join(', ')}
      listClassName="chat-workers-popover"
      label={
        <>
          Assignments ({work.jobs.length})
          {flagged > 0 && <span className="chat-workers-flag"> · {flagged} flagged</span>}
        </>
      }
    >
      <AssignmentsPanel {...props} work={work} />
    </Popover>
  )
}

function AssignmentsPanel({
  team,
  openTerminal,
  work,
}: Props & { work: ReturnType<typeof useTeamWork> }) {
  const close = useContext(CloseMenu)
  const records = useStore((s) => s.sessionRecords)
  const { act, run, busy, error } = useTeamAction(team)
  const { sessions, jobs, dismissed } = work
  // The last dismissal, offered for undo; its button takes focus from the row that went away.
  const [undo, setUndo] = useState<ProviderJob>()
  const undoButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (undo) undoButton.current?.focus()
  }, [undo])
  // Close first so focus returns to the trigger, then let the surface that opens take it.
  const leave = (open: () => void) => () => {
    close()
    open()
  }
  const dismiss = (job: ProviderJob) => {
    work.setDismissed(job, true)
    setUndo(job)
  }
  const restore = (job: ProviderJob) => {
    work.setDismissed(job, false)
    setUndo(undefined)
  }
  const active = jobs.filter((job) => workerStatus(job, sessions) !== 'complete')
  const counts = workerCounts(jobs, sessions)
  const rank = (job: ProviderJob) =>
    workerStatus(job, sessions) === 'complete' ? 2 : failed(job) ? 1 : 0
  const step = (job: ProviderJob) => {
    const last = job.sessionId ? turnSteps(sessions[job.sessionId]).at(-1) : undefined
    return last && activityLabel(last, workerSession(job, records, team.projectId)?.spec.cwd)
  }
  return (
    <div className="chat-workers">
      <p role="status">
        {team.state === 'running'
          ? active.length
            ? Object.entries(counts)
                .filter(([, count]) => count > 0)
                .map(([status, count]) => `${count} ${status}`)
                .join(' · ')
            : 'Ready'
          : team.state === 'paused'
            ? work.restartNotice
              ? RESTART_NOTICE
              : 'Paused'
            : team.state === 'stopped'
              ? 'Stopped'
              : 'Complete'}
        {team.reset && !team.reset.error && ' · Restoring context…'}
      </p>
      {undo && dismissed.some((job) => job.id === undo.id) && (
        <p role="status" className="chat-workers-undo">
          Dismissed {undo.terminal.name}.{' '}
          <button ref={undoButton} onClick={() => restore(undo)}>
            Undo
          </button>
        </p>
      )}
      {jobs.length === 0 ? (
        <p>{work.allJobs.length ? 'All assignments dismissed.' : 'No assignments yet.'}</p>
      ) : (
        <ul>
          {jobs
            .sort((a, b) => rank(a) - rank(b))
            .map((job) => {
              const status = workerStatus(job, sessions)
              const label = step(job)
              const done = status === 'complete'
              const record = workerSession(job, records, team.projectId)
              return (
                <li key={job.id} data-status={failed(job) ? 'failed' : status}>
                  <strong>{job.terminal.name}</strong> · {status}
                  {label && <> · {label}</>}
                  {job.summary && <p>{job.summary}</p>}
                  {!(done && job.summary) && <Instructions text={job.instructions} />}
                  {job.report && <AssignmentReport report={job.report} />}
                  {job.error && <p>{job.error}</p>}
                  <div className="chat-workers-actions">
                    <button
                      disabled={!record}
                      onClick={leave(() => record && openTerminal(record))}
                    >
                      View worker terminal
                    </button>
                    {failed(job) && (
                      <>
                        <button
                          disabled={busy}
                          onClick={() => void act({ kind: 'retry', assignment: job.id })}
                        >
                          Retry work
                        </button>
                        <RetryOnAgent team={team} job={job} busy={busy} run={run} />
                        <button onClick={leave(showSettings)}>Agent settings</button>
                      </>
                    )}
                    {(done || failed(job)) && <button onClick={() => dismiss(job)}>Dismiss</button>}
                  </div>
                </li>
              )
            })}
        </ul>
      )}
      {dismissed.length > 0 && (
        <details className="chat-workers-dismissed">
          <summary>Dismissed ({dismissed.length})</summary>
          <ul>
            {dismissed.map((job) => (
              <li key={job.id}>
                {job.terminal.name} · {failed(job) ? 'failed' : workerStatus(job, sessions)}{' '}
                <button onClick={() => restore(job)}>Restore</button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <button onClick={leave(showSessions)}>Open Sessions</button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}

/** Short instructions read in full; long ones show their first line until expanded. */
function Instructions({ text }: { text: string }) {
  const first = text.split('\n', 1)[0]
  if (first === text && text.length <= 160) return <p>{text}</p>
  return (
    <details className="assignment-instructions">
      <summary>{first}</summary>
      <p>{text}</p>
    </details>
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
