import { useStore } from '../store'
import { retryOnAgent, type ChatTeam } from '../lib/chatTeams'
import { useClockNow } from '../lib/clock'
import { planTerminals } from '../lib/plan'
import { presetExhausted, useUsage } from '../lib/usage'
import type { ProviderJob, ScanReport } from '../lib/orchestration'
import { selectPanel, useRail } from '../lib/rail'
import type { SessionRecord } from '../types'
import { workerSession } from '../lib/chatProgress'
import { useTeamAction, useTeamWork } from '../lib/useTeamWork'

type Props = { team: ChatTeam; openTerminal: (record: SessionRecord) => void }

export const showSettings = () => useRail.setState({ settings: 'roles' })
export const showSessions = () => selectPanel('sessions')

/** Offers the other agent presets for a failed assignment. */
export function RetryOnAgent({
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
 * the Agents tab.
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

/** Short instructions read in full; long ones show their first line until expanded. */
export function Instructions({ text }: { text: string }) {
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
export function AssignmentReport({ report }: { report: ScanReport }) {
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
