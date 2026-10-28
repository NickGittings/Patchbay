import { latestWrite } from '../lib/activity'
import type { SimpleDiff } from '../lib/simpleUi'
import type { SimpleEntry } from '../lib/simple'
import { SIMPLE_ROLE_LABEL, recordStage } from '../lib/simple'
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
  worktree,
  openFile,
}: {
  record?: SessionRecord
  sessionId: string
  entries: SimpleEntry[]
  latest: boolean
  working: boolean
  worktree: string
  openFile: (file: SimpleDiff) => void
}) {
  const session = useStore((s) => s.sessions[sessionId])
  const nodes = useStore((s) => s.nodes)
  const edited =
    latest && record
      ? latestWrite(
          record,
          session,
          nodes.map((n) => ({ id: n.id, path: n.data.path })),
          worktree,
        )
      : undefined
  const busy = working || (session?.running && session.status?.agent?.state === 'working')
  const role = record ? SIMPLE_ROLE_LABEL[recordStage(record)] : 'Agent'
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
      {edited && (
        <button className="simple-edited" onClick={() => openFile(edited)}>
          Edited {edited.path}
        </button>
      )}
      {latest && busy && <p className="simple-working">Working…</p>}
    </article>
  )
}
