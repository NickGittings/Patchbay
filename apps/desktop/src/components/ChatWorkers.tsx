import { useState } from 'react'
import { projectOf, useStore } from '../store'
import {
  requireTeamPreset,
  useChatTeams,
  controlTeam,
  sendWorkerMessage,
  type ChatTeam,
} from '../lib/chatTeams'
import { planTerminals } from '../lib/plan'
import Markdown from './findings/Markdown'
import TerminalPane from './TerminalPane'

export default function ChatWorkers({ team }: { team: ChatTeam }) {
  const runs = useChatTeams((s) => s.runs[team.projectId]) ?? []
  const sessions = useStore((s) => s.sessions)
  const records = useStore((s) => s.sessionRecords)
  const devices = useStore((s) => s.devices)
  const jobs = runs.filter((r) => r.chatTeam === team.id).flatMap((r) => r.jobs)
  const [thread, setThread] = useState<string>()
  const [terminal, setTerminal] = useState<string>()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [limit, setLimit] = useState(team.limit)
  const [presets, setPresets] = useState(team.workers.map((w) => w.id))
  const [settings, setSettings] = useState(false)
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const choices = [...team.workers, ...planTerminals(devices)].filter(
    (preset, i, all) => all.findIndex((p) => p.id === preset.id) === i,
  )
  return (
    <details
      className="chat-workers"
      open={jobs.some((j) => ['failed', 'running', 'launching'].includes(j.state)) || !!team.reset}
    >
      <summary>
        Worker activity · {jobs.length} assignments · {team.state} · up to {team.limit} workers
      </summary>
      <div className="simple-step-actions">
        {team.state === 'running' ? (
          <button
            disabled={busy}
            onClick={() => void run(() => controlTeam(team, { kind: 'pause' }))}
          >
            Pause
          </button>
        ) : (
          <button
            disabled={busy}
            onClick={() => void run(() => controlTeam(team, { kind: 'resume' }))}
          >
            Resume
          </button>
        )}
        <button
          disabled={busy || team.state === 'stopped'}
          onClick={() => void run(() => controlTeam(team, { kind: 'stop' }))}
        >
          Stop workers
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setLimit(team.limit)
            setPresets(team.workers.map((w) => w.id))
            setSettings(!settings)
          }}
        >
          Worker settings…
        </button>
      </div>
      {team.state === 'paused' && (
        <p>New workers, updates and integration are paused. Current turns may finish.</p>
      )}
      {team.reset && (
        <p role="status">
          {team.reset.phase === 'queued'
            ? 'New agent conversation queued for the next confirmed ready prompt. A concise work handoff is retained.'
            : team.reset.phase === 'launching'
              ? 'Starting the new agent conversation…'
              : team.reset.error}
        </p>
      )}
      {team.error && <p role="status">{team.error}</p>}
      {settings && (
        <fieldset disabled={busy}>
          <legend>Workers for future rounds</legend>
          <label>
            Concurrent workers{' '}
            <input
              aria-label="Concurrent workers"
              type="number"
              min={1}
              max={8}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
          </label>
          {choices.map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                checked={presets.includes(p.id)}
                onChange={(e) =>
                  setPresets(
                    e.target.checked ? [...presets, p.id] : presets.filter((id) => id !== p.id),
                  )
                }
              />
              {p.name}
            </label>
          ))}
          <button
            onClick={() =>
              void run(async () => {
                const project = projectOf(team.projectId)
                if (!project) throw new Error('Open this project before changing workers')
                const workers = choices.filter((p) => presets.includes(p.id))
                if (!workers.length) throw new Error('Choose at least one worker preset')
                for (const worker of workers) {
                  await requireTeamPreset(worker, project, team.task)
                }
                await controlTeam(team, { kind: 'settings', workers, limit })
                setSettings(false)
              })
            }
          >
            Save worker settings
          </button>
        </fieldset>
      )}
      {!jobs.length && (
        <p>
          Your agent can delegate investigation, review and implementation. Workers use isolated
          worktrees.
        </p>
      )}
      {jobs.map((job) => {
        const record = records.find((r) => r.id === job.sessionId)
        const state = job.sessionId ? sessions[job.sessionId] : undefined
        const messages = team.messages.filter(
          (m) => m.assignment === job.id && m.sender !== 'patchbay',
        )
        return (
          <article className="chat-worker" key={job.id}>
            <p>
              <strong>{job.instructions.split('\n')[0] || job.id}</strong> · {job.terminal.name} ·{' '}
              {job.resultKind ?? 'code'} · {job.state}
              {state?.status?.agent?.state === 'needsInput' ? ' · needs input in terminal' : ''}
            </p>
            {job.error && <p role="status">{job.error}</p>}
            {job.summary && (
              <details>
                <summary>Result{job.base ? ` · baseline ${job.base.slice(0, 10)}` : ''}</summary>
                <Markdown text={job.summary} />
                {job.commit && <code>{job.commit}</code>}
              </details>
            )}
            <div className="simple-step-actions">
              <button onClick={() => setThread(thread === job.id ? undefined : job.id)}>
                {thread === job.id ? 'Close' : 'Open'} side thread
              </button>
              <button
                disabled={!record}
                onClick={() => setTerminal(terminal === job.id ? undefined : job.id)}
              >
                {terminal === job.id ? 'Hide' : 'View'} terminal
              </button>
              {['failed', 'launching'].includes(job.state) && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(() => controlTeam(team, { kind: 'retry', assignment: job.id }))
                  }
                >
                  Retry
                </button>
              )}
            </div>
            {thread === job.id && (
              <section aria-label={`Side thread ${job.id}`}>
                {messages.map((message) => (
                  <div key={message.id}>
                    <p>
                      {message.sender} → {message.recipient} · {message.state}
                    </p>
                    <Markdown text={message.text} />
                  </div>
                ))}
                {(state?.replies ?? []).map((reply) => (
                  <Markdown key={`${state?.generation}:${reply.sequence}`} text={reply.text} />
                ))}
                <label>
                  Message this worker
                  <textarea
                    value={drafts[job.id] ?? ''}
                    onChange={(e) => setDrafts({ ...drafts, [job.id]: e.target.value })}
                  />
                </label>
                <button
                  disabled={busy || !drafts[job.id]?.trim()}
                  onClick={() =>
                    void run(async () => {
                      const text = drafts[job.id]
                      await sendWorkerMessage(team, job.id, text)
                      setDrafts((drafts) =>
                        drafts[job.id] === text ? { ...drafts, [job.id]: '' } : drafts,
                      )
                    })
                  }
                >
                  Send to worker and copy agent
                </button>
              </section>
            )}
            {terminal === job.id && record && (
              <div className="simple-terminal-drawer">
                <TerminalPane
                  componentId={record.metadata.componentId}
                  terminal={job.terminal}
                  task={record.metadata.task ?? null}
                  existingSessionId={record.id}
                  focus={false}
                />
              </div>
            )}
          </article>
        )
      })}
      {team.messages
        .filter((m) => m.state === 'uncertain')
        .map((message) => (
          <div key={message.id} role="alert">
            <p>
              Message {message.sequence} to {message.recipient} was not confirmed. Inspect the
              terminal before resolving.
            </p>
            <button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  controlTeam(team, { kind: 'resolveDelivery', id: message.id, delivered: true }),
                )
              }
            >
              Mark delivered
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  controlTeam(team, { kind: 'resolveDelivery', id: message.id, delivered: false }),
                )
              }
            >
              Retry delivery
            </button>
          </div>
        ))}
      {error && <p role="alert">{error}</p>}
    </details>
  )
}
