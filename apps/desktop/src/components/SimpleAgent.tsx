import { useContext } from 'react'
import { SimpleChangesContext } from './stories/simpleChanges'
import { simpleKey, useSimpleUi, type SimpleDiff } from '../lib/simpleUi'
import type { SimpleEntry } from '../lib/simple'
import { useChatIdentity } from '../lib/chatIdentity'
import { chatReplyId } from '../lib/chatNavigation'
import { useStore } from '../store'
import { activityLabel, turnSteps } from '../lib/activity'
import type { SessionRecord } from '../types'
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
    <article className="simple-agent" data-session={sessionId}>
      <header>
        <strong>{identity.title}</strong>
        {latest && <SimpleStatus sessions={[session]} />}
        {record && (
          <button
            aria-label={`View ${identity.role} terminal`}
            title={`View ${identity.role} terminal`}
            onClick={() => {
              const s = useStore.getState()
              useSimpleUi.getState().patch(simpleKey(s.project?.id, s.activeTask), {
                terminal: 'user',
                terminalSession: { id: sessionId, generation: session?.generation, pinned: true },
              })
            }}
          >
            Terminal
          </button>
        )}
      </header>
      {entries.map((entry) =>
        entry.kind === 'prompt' ? (
          <div className="simple-prompt" data-chat-entry={entry.id} key={entry.id}>
            <strong>You</strong>
            <MessageMeta atMs={entry.atMs} text={entry.text} />
            <pre>{entry.text}</pre>
          </div>
        ) : entry.kind === 'reply' ? (
          <div className="simple-reply" data-chat-entry={chatReplyId(entry)} key={entry.id}>
            <MessageMeta atMs={entry.atMs} text={entry.text} />
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
          <p>{current ? activityLabel(current, record?.spec.cwd) : 'Working…'}</p>
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
