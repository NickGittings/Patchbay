import { useStore } from '../store'
import { controlTeam, useChatTeams, type ChatTeam } from '../lib/chatTeams'
import { selectPanel, useRail } from '../lib/rail'
import { useState } from 'react'

/** Only coordination status and actionable exceptions belong beside the lead conversation. */
export default function ChatCoordination({ team }: { team: ChatTeam }) {
  const runs = useChatTeams((s) => s.runs[team.projectId])
  const sessions = useStore((s) => s.sessions)
  const jobs = (runs ?? []).filter((r) => r.chatTeam === team.id).flatMap((r) => r.jobs)
  const active = jobs.filter((j) => ['pending', 'launching', 'running'].includes(j.state))
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
  const asking = jobs.filter(
    (j) => j.sessionId && sessions[j.sessionId]?.status?.agent?.state === 'needsInput',
  )
  return (
    <div className="chat-coordination" aria-label="Work status">
      <p role="status">
        {team.state === 'running'
          ? active.length
            ? 'Coordinating work…'
            : 'Ready'
          : team.state === 'paused'
            ? 'Work paused · You can still message the lead'
            : team.state === 'stopped'
              ? 'Work stopped · You can still message the lead'
              : 'Work complete'}
      </p>
      {team.reset && <p role="status">{team.reset.error ?? 'Restoring context…'}</p>}
      {team.error && <p role="alert">{team.error}</p>}
      {failures.map((job) => (
        <p role="alert" key={job.id}>
          {job.terminal.name}: {job.error ?? 'Work failed'}{' '}
          <button disabled={busy} onClick={() => void act({ kind: 'retry', assignment: job.id })}>
            Retry work
          </button>
          <button onClick={() => useRail.setState({ settings: 'roles' })}>Agent settings</button>
        </p>
      ))}
      {asking.length > 0 && (
        <p role="alert">
          {asking.map((j) => j.terminal.name).join(', ')} needs permission or input.{' '}
          <button onClick={() => selectPanel('sessions')}>Open Sessions</button>
        </p>
      )}
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
