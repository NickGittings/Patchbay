import { useStore } from '../store'
import { thread } from '../lib/simple'
import { useSimpleData } from '../lib/useSimpleData'
import Markdown from './findings/Markdown'
import { changeGroups } from '../lib/changeGroups'
import './simple.css'

export default function SimpleChat() {
  const s = useStore()
  const { data, source, error } = useSimpleData(true)
  if (!s.project) return null
  const worktree = {
    projectId: s.project.id,
    task: s.activeTask,
    path: source?.path ?? s.project.root,
    branch: source?.branch,
  }
  const model = thread(
    { records: s.sessionRecords, sessions: s.sessions, simple: s.simple, auto: s.auto, ...data },
    worktree,
  )
  const groups = changeGroups(s.nodes, data?.review)
  return (
    <div className="simple-chat">
      <header>
        <strong>Worktree chat</strong>
        <span>{source?.branch ?? 'Project folder'}</span>
      </header>
      {error && <p role="alert">{error}</p>}
      <div className="simple-thread">
        {model.sections.map((section) => (
          <section
            className="simple-stage"
            key={section.id}
            aria-current={model.stage === section.id ? 'step' : undefined}
          >
            <h2>{section.id[0].toUpperCase() + section.id.slice(1)}</h2>
            {section.id === 'plan' && (
              <article>
                <h3>Project plan · shared across worktree chats</h3>
                <Markdown text={data?.plan.text || 'No saved plan yet.'} />
                {data?.proposal && <Markdown text={data.proposal.plan} />}
              </article>
            )}
            {section.id === 'build' && (
              <article>
                <h3>Accepted worktree plan</h3>
                <Markdown text={data?.acceptedPlan.text || 'No accepted plan yet.'} />
                <h3>Changes</h3>
                {groups.map((g) => (
                  <p key={g.id}>
                    {g.name} · {g.files.length} files
                  </p>
                ))}
              </article>
            )}
            {section.id === 'review' && <article>Review findings appear here.</article>}
            {section.id === 'merge' && (
              <article>{data?.outcome ?? 'Choose a merge destination after review.'}</article>
            )}
            {section.entries.map((entry) => (
              <article key={entry.id}>
                <time>{new Date(entry.atMs).toLocaleTimeString()}</time>
                {entry.kind === 'prompt' ? <pre>You: {entry.text}</pre> : entry.action}
              </article>
            ))}
            {section.sessions.map((r) => (
              <article key={r.id}>
                {r.metadata.name} · {s.sessions[r.id]?.running ? 'Running' : 'Closed'}
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}
