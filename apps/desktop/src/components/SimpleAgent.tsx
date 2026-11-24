import { useContext } from 'react'
import { SimpleChangesContext } from './stories/simpleChanges'
import { pinChatTerminal, simpleKey, type SimpleDiff } from '../lib/simpleUi'
import type { SimpleEntry } from '../lib/simple'
import { useChatIdentity } from '../lib/chatIdentity'
import { chatReplyId } from '../lib/chatNavigation'
import { useStore } from '../store'
import { activityLabel, replyTurn, turnLength, turnStartMs, turnSteps } from '../lib/activity'
import { useClockNow } from '../lib/clock'
import type { Activity, SessionRecord } from '../types'
import Markdown from './findings/Markdown'
import SimpleStatus from './SimpleStatus'
import MessageMeta from './MessageMeta'

export default function SimpleAgent({
  record,
  sessionId,
  entries,
  latest,
  working,
  openFile,
}: {
  record?: SessionRecord
  sessionId: string
  entries: SimpleEntry[]
  latest: boolean
  working: boolean
  openFile: (file: SimpleDiff) => void
}) {
  const session = useStore((s) => s.sessions[sessionId])
  const changes = useContext(SimpleChangesContext)
  const edited = latest ? changes.bySession.get(sessionId) : undefined
  const busy = working || (session?.running && session.status?.agent?.state === 'working')
  const identity = useChatIdentity(record)
  // What the agent is doing now, from its hooks, so progress doesn't need its terminal.
  const steps = latest && busy ? turnSteps(session) : []
  const current = steps.at(-1)
  return (
    <article className="simple-agent" data-session={sessionId} data-role={identity.roleKey}>
      <header>
        <strong className="chat-role">{identity.role}</strong>
        {identity.detail && <span className="chat-role-detail">{identity.detail}</span>}
        {latest && <SimpleStatus sessions={[session]} />}
        {record && (
          <button
            aria-label={`View ${identity.role} terminal`}
            title={`View ${identity.role} terminal`}
            onClick={() => {
              const s = useStore.getState()
              pinChatTerminal(
                simpleKey(s.project?.id, s.activeTask),
                sessionId,
                session?.generation,
              )
            }}
          >
            Terminal
          </button>
        )}
      </header>
      {entries.map((entry, index) =>
        entry.kind === 'prompt' ? (
          <div className="simple-prompt" data-chat-entry={entry.id} key={entry.id}>
            <strong>You</strong>
            <MessageMeta atMs={entry.atMs} text={entry.text} />
            <pre>{entry.text}</pre>
          </div>
        ) : entry.kind === 'reply' ? (
          <div className="simple-reply" data-chat-entry={chatReplyId(entry)} key={entry.id}>
            <MessageMeta atMs={entry.atMs} text={entry.text} />
            <TurnSteps
              cwd={record?.spec.cwd}
              {...replyTurn(session, entry, promptBefore(entries, index))}
            />
            <Markdown text={entry.text} />
          </div>
        ) : null,
      )}
      {edited && (
        <button className="simple-edited" onClick={() => openFile(edited)}>
          Edited {edited.path}
        </button>
      )}
      {latest && busy && (
        <div className="simple-working" role="status">
          <p>
            {current ? activityLabel(current, record?.spec.cwd) : 'Working…'}
            {session?.status?.agent?.state === 'working' && (
              <TurnTimer
                sinceMs={turnStartMs(
                  promptBefore(entries, entries.length),
                  steps,
                  session.status.agent.sinceMs,
                )}
              />
            )}
          </p>
          {steps.length > 1 && (
            <details className="simple-steps">
              <summary>{steps.length} steps</summary>
              <ol>
                {steps.map((step) => (
                  <li key={step.sequence}>{activityLabel(step, record?.spec.cwd)}</li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
    </article>
  )
}

/** When the user's prompt that started the turn ending at `index` was sent, if it is shown. */
function promptBefore(entries: SimpleEntry[], index: number) {
  for (let i = index - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.kind === 'reply') return undefined
    if (entry.kind === 'prompt') return entry.atMs
  }
  return undefined
}

/** What a finished turn did, folded under its reply so the work stays visible. */
function TurnSteps({
  steps,
  durationMs,
  cwd,
}: {
  steps: Activity[]
  durationMs?: number
  cwd?: string
}) {
  const time = durationMs === undefined ? undefined : turnLength(durationMs)
  if (!steps.length) return time ? <p className="simple-turn-time">Worked for {time}</p> : null
  const summary = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}${time ? ` · ${time}` : ''}`
  return (
    <details className="simple-steps simple-turn-steps">
      <summary>{summary}</summary>
      <ol>
        {steps.map((step) => (
          <li key={step.sequence}>{activityLabel(step, cwd)}</li>
        ))}
      </ol>
    </details>
  )
}

/** How long the current turn has run; only this leaf subscribes to the clock. */
function TurnTimer({ sinceMs }: { sinceMs: number }) {
  // The shared clock ticks every ten seconds, so a running turn shows whole minutes.
  const now = useClockNow()
  const ms = Math.max(0, now - sinceMs)
  return (
    <span className="simple-turn-time">
      {' '}
      · {ms < 60_000 ? '<1m' : turnLength(ms - (ms % 60_000))}
    </span>
  )
}
