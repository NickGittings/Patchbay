import { useContext } from 'react'
import { SimpleChangesContext } from './stories/simpleChanges'
import { simpleKey, useSimpleUi, type SimpleDiff } from '../lib/simpleUi'
import type { SimpleEntry } from '../lib/simple'
import { useChatIdentity } from '../lib/chatIdentity'
import { useStore } from '../store'
import type { SessionRecord } from '../types'
import Markdown from './findings/Markdown'
import SimpleStatus from './SimpleStatus'

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
  return (
    <article className="simple-agent" data-session={sessionId}>
      <header>
        <strong>
          {identity.label}
          {identity.preset && <span> · Preset: {identity.preset}</span>}
        </strong>
        {latest && <SimpleStatus sessions={[session]} />}
        {record && (
          <button
            onClick={() => {
              const s = useStore.getState()
              useSimpleUi.getState().patch(simpleKey(s.project?.id, s.activeTask), {
                terminal: 'user',
                terminalSession: { id: sessionId, generation: session?.generation, pinned: true },
              })
            }}
          >
            View {identity.role} terminal
          </button>
        )}
      </header>
      {entries.map((entry) =>
        entry.kind === 'prompt' ? (
          <div className="simple-prompt" key={entry.id}>
            <strong>You</strong>
            <pre>{entry.text}</pre>
          </div>
        ) : entry.kind === 'reply' ? (
          <div className="simple-reply" key={entry.id}>
            <Markdown text={entry.text} />
          </div>
        ) : null,
      )}
      {edited && (
        <button className="simple-edited" onClick={() => openFile(edited)}>
          Edited {edited.path}
        </button>
      )}
      {latest && busy && <p className="simple-working">Working…</p>}
    </article>
  )
}
