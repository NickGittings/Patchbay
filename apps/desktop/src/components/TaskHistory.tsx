import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { refreshTaskCycle, useTaskCycles, type FinishedTask } from '../lib/workCycles'
import { simpleKey } from '../lib/simpleUi'
import { sessionResume } from '../lib/ipc'
import { reconcileFreshSessions } from '../lib/sessions'
import Markdown from './findings/Markdown'
import TerminalPane from './TerminalPane'

export default function TaskHistory({
  projectId,
  task,
  close,
}: {
  projectId: string
  task: string | null
  close: () => void
}) {
  const history = useTaskCycles((s) => s.scopes[simpleKey(projectId, task)]?.history)
  const records = useStore((s) => s.sessionRecords)
  const connected = useStore((s) => s.serviceConnected)
  const [selected, setSelected] = useState<FinishedTask>()
  const [output, setOutput] = useState<string>()
  const [resume, setResume] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    void refreshTaskCycle(projectId, task).catch((e) => setError(String(e)))
  }, [projectId, task])
  const record = records.find((r) => r.id === output)
  return (
    <div className="extension-overlay centered" onClick={close}>
      <section
        className="extensions-panel task-history"
        role="dialog"
        aria-modal="true"
        aria-label="Task history"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
        }}
      >
        <header className="row">
          <h2>Task history</h2>
          <span className="spacer" />
          <button onClick={close}>Close</button>
        </header>
        {error && <p role="alert">{error}</p>}
        {!selected ? (
          <>
            {!history?.length && <p>No finished tasks in this worktree.</p>}
            {history?.map((archive) => (
              <button
                className="task-history-item"
                key={archive.nextCycle}
                onClick={() => setSelected(archive)}
              >
                <time>{new Date(archive.completedMs).toLocaleString()}</time> ·{' '}
                {archive.branch || 'Detached HEAD'}
                <strong>{archive.firstRequest}</strong>
              </button>
            ))}
          </>
        ) : (
          <>
            <button
              onClick={() => {
                setSelected(undefined)
                setOutput(undefined)
                setResume(undefined)
              }}
            >
              All finished tasks
            </button>
            <h3>{selected.firstRequest}</h3>
            <p>
              {new Date(selected.completedMs).toLocaleString()} ·{' '}
              {selected.branch || 'Detached HEAD'}
            </p>
            <p className="hint">
              Saved Patchbay chat and retained session output are available here. Provider
              conversation resume depends on the provider’s saved history.
            </p>
            <h3>Chat</h3>
            {selected.workspace.simple?.log.map((entry) => (
              <article key={entry.id}>
                <strong>
                  {entry.kind === 'prompt' ? 'You' : entry.kind === 'reply' ? 'Agent' : 'Action'}
                </strong>
                <Markdown text={'text' in entry ? (entry.text ?? entry.kind) : entry.kind} />
              </article>
            ))}
            {selected.artifacts.map((artifact) => (
              <details key={artifact.path} open={artifact.path.endsWith('.md')}>
                <summary>{artifact.path.split(/[\\/]/).at(-1)}</summary>
                <Markdown text={artifact.text} />
              </details>
            ))}
            <details>
              <summary>Auto and workspace state</summary>
              <pre>{JSON.stringify(selected.workspace, null, 2)}</pre>
            </details>
            <details>
              <summary>Coordination records and results</summary>
              <pre>{JSON.stringify(selected.coordination, null, 2)}</pre>
            </details>
            <h3>Agent sessions</h3>
            {selected.sessions.map((session) => (
              <div className="row" key={session.id}>
                <span>{session.name}</span>
                <button
                  disabled={!records.some((r) => r.id === session.id)}
                  onClick={() => setOutput(session.id)}
                >
                  View output
                </button>
                <button
                  disabled={
                    !connected ||
                    busy ||
                    !records.some((r) => r.id === session.id && r.metadata.adapter)
                  }
                  onClick={() => setResume(session.id)}
                >
                  Resume
                </button>
              </div>
            ))}
            {resume && (
              <div role="alertdialog" aria-label="Resume archived agent">
                <p>
                  This archived agent runs against this worktree’s current files. It stays separate
                  from the active task.
                </p>
                <button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    setError('')
                    void sessionResume(resume)
                      .then(reconcileFreshSessions)
                      .then(() => {
                        setOutput(resume)
                        setResume(undefined)
                      })
                      .catch((e) => setError(String(e)))
                      .finally(() => setBusy(false))
                  }}
                >
                  Resume archived agent
                </button>
                <button disabled={busy} onClick={() => setResume(undefined)}>
                  Cancel
                </button>
              </div>
            )}
            {record && (
              <div className="task-history-output">
                <TerminalPane
                  existingSessionId={record.id}
                  componentId={record.metadata.componentId}
                  terminal={{
                    id: record.metadata.terminalId,
                    name: record.metadata.name,
                    kind: 'agent',
                    command: record.spec.command,
                  }}
                />
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
