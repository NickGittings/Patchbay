import { useStore } from '../store'
import { controlTeam, useChatTeams, type ChatTeam } from '../lib/chatTeams'
import { selectPanel, useRail } from '../lib/rail'
import { useState } from 'react'
import type { SessionRecord } from '../types'
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
  const failures = jobs.filter((j) => j.state === 'failed' || (j.state === 'launching' && j.error))
  const asking = jobs.filter((j) => workerStatus(j, sessions) === 'awaiting input')
  return (
    <div className="chat-coordination" aria-label="Work status">
      <p role="status">
        {team.state === 'running'
          ? active.length
            ? Object.entries(counts)
                .map(([status, count]) => `${count} ${status}`)
                .join(' · ')
            : 'Ready'
          : team.state === 'paused'
            ? 'Work paused · You can still message the lead'
            : team.state === 'stopped'
              ? 'Work stopped · You can still message the lead'
              : 'Work complete'}
      </p>
      {active.length > 0 && (
        <details className="chat-workers">
          <summary>Workers ({active.length})</summary>
          <ul>
            {active.map((job) => (
              <li key={job.id}>
                <strong>{job.terminal.name}</strong> · {workerStatus(job, sessions)}
                <p>{job.instructions}</p>
                {terminalAction(job)}
              </li>
            ))}
          </ul>
          <button onClick={() => selectPanel('sessions')}>Open Sessions</button>
        </details>
      )}
      {team.reset && <p role="status">{team.reset.error ?? 'Restoring context…'}</p>}
      {team.error && <p role="alert">{team.error}</p>}
      {failures.map((job) => (
        <p role="alert" key={job.id}>
          {job.terminal.name}: {job.error ?? 'Work failed'} {terminalAction(job)}
          <button disabled={busy} onClick={() => void act({ kind: 'retry', assignment: job.id })}>
            Retry work
          </button>
          <button onClick={() => useRail.setState({ settings: 'roles' })}>Agent settings</button>
        </p>
      ))}
      {asking.map((job) => (
        <p role="alert" key={job.id}>
          {job.terminal.name} needs permission or input. {terminalAction(job)}{' '}
          <button onClick={() => selectPanel('sessions')}>Open Sessions</button>
        </p>
      ))}
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
