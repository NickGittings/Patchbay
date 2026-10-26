import type { SimpleEntry } from '../lib/simple'
import { recordStage } from '../lib/simple'
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
}: {
  record?: SessionRecord
  sessionId: string
  entries: SimpleEntry[]
  latest: boolean
  working: boolean
}) {
  const session = useStore((s) => s.sessions[sessionId])
  const busy = working || (session?.running && session.status?.agent?.state === 'working')
  const role = record
    ? { plan: 'Planner', build: 'Builder', review: 'Reviewer', merge: 'Merge agent' }[
        recordStage(record)
      ]
    : 'Agent'
  const provider = record?.metadata.adapter
  return (
    <article className="simple-agent" data-session={sessionId}>
      <header>
        <strong>
          {role}
          {provider
            ? ` · ${provider === 'claude' ? 'Claude' : 'Codex'}`
            : record
              ? ` · ${record.metadata.name}`
              : ''}
        </strong>
        {latest && <SimpleStatus sessions={[session]} />}
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
      {latest && busy && <p className="simple-working">Working…</p>}
    </article>
  )
}
