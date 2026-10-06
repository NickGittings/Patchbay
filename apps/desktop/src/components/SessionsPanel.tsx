import { useState } from 'react'
import { useStore } from '../store'
import {
  quitPatchbay,
  sessionConversation,
  sessionHistory,
  sessionForget,
  sessionResume,
  terminalStop,
} from '../lib/ipc'
import { hydrateSession, reconcileSessions, startTerminal } from '../lib/sessions'
import { flushWorkspace } from '../lib/workspace'
import { ago } from '../lib/review'
import type { SessionRecord } from '../types'
import TerminalPane from './TerminalPane'

export default function SessionsPanel() {
  const open = useStore((s) => s.sessionsPanelOpen)
  const records = useStore((s) => s.sessionRecords)
  const connected = useStore((s) => s.serviceConnected)
  const [selected, setSelected] = useState<SessionRecord>()
  const [conversation, setConversation] = useState<{ id: string; value: string }>()
  const [historyOutput, setHistoryOutput] = useState('')
  const [history, setHistory] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      await reconcileSessions()
    } catch (e) {
      useStore.getState().setMessage(String(e))
    } finally {
      setBusy(false)
    }
  }
  if (!open) return null
  const groups = [...new Set(records.map((r) => r.metadata.projectId))]
  return (
    <div
      className="extension-overlay"
      onClick={() => useStore.setState({ sessionsPanelOpen: false })}
    >
      <div
        className="sessions-panel panel"
        role="dialog"
        aria-modal="true"
        aria-label="Workspace sessions"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row">
          <h2>Workspace sessions</h2>
          <span className="spacer" />
          <span>{connected ? 'Connected' : 'Disconnected · reconnecting…'}</span>
          <button onClick={() => useStore.setState({ sessionsPanelOpen: false })}>Close</button>
        </div>
        <p>
          Closing tabs, windows, or quitting Patchbay leaves work running. Stop terminates it
          explicitly.
        </p>
        {!records.length && <p>No retained sessions.</p>}
        <div className="session-list">
          {groups.map((projectId) => (
            <section key={projectId}>
              <h3>
                {records.find((r) => r.metadata.projectId === projectId)?.metadata.projectName}
              </h3>
              {records
                .filter((r) => r.metadata.projectId === projectId)
                .map((r) => (
                  <div className="session-row" key={r.id}>
                    <div>
                      <strong>{r.metadata.name}</strong>
                      <small>
                        {r.metadata.componentId} · {r.metadata.kind} · {r.spec.cwd}
                      </small>
                    </div>
                    <span>
                      {!connected
                        ? 'Disconnected'
                        : r.snapshot?.running
                          ? 'Running'
                          : r.interrupted
                            ? 'Interrupted'
                            : 'Ended'}
                    </span>
                    <small>
                      {r.snapshot?.status.lastOutputMs
                        ? ago(r.snapshot.status.lastOutputMs, Date.now())
                        : ''}
                    </small>
                    <button
                      disabled={!connected || busy}
                      onClick={() =>
                        void perform(async () => {
                          await hydrateSession(r.id)
                          setSelected(r)
                          setHistory(null)
                        })
                      }
                    >
                      {r.snapshot?.running ? 'Reconnect' : 'View output'}
                    </button>
                    {r.snapshot?.running ? (
                      <button
                        disabled={!connected || busy}
                        onClick={() => void perform(() => terminalStop(r.id))}
                      >
                        Stop
                      </button>
                    ) : (
                      <>
                        {r.metadata.adapter && (
                          <button
                            disabled={!connected || busy}
                            onClick={() => void perform(() => sessionResume(r.id))}
                          >
                            Resume conversation
                          </button>
                        )}
                        <button
                          disabled={
                            !connected ||
                            busy ||
                            !useStore.getState().projects[r.metadata.projectId]?.state
                          }
                          onClick={() =>
                            void perform(async () => {
                              useStore.getState().activateProject(r.metadata.projectId)
                              await startTerminal(
                                r.metadata.componentId,
                                r.metadata.terminalId,
                                r.metadata.task ?? null,
                                r.metadata.projectId,
                              )
                            })
                          }
                        >
                          Start new
                        </button>
                        <button
                          disabled={!connected || busy}
                          onClick={() => void perform(() => sessionForget(r.id))}
                        >
                          Forget
                        </button>
                      </>
                    )}
                    {r.metadata.adapter && (
                      <button
                        disabled={!connected || busy}
                        onClick={() =>
                          setConversation({ id: r.id, value: r.metadata.conversationId ?? '' })
                        }
                      >
                        Set conversation ID
                      </button>
                    )}
                  </div>
                ))}
            </section>
          ))}
        </div>
        {conversation && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              void perform(async () => {
                await sessionConversation(conversation.id, conversation.value)
                setConversation(undefined)
              })
            }}
          >
            <label>
              Exact provider conversation ID{' '}
              <input
                value={conversation.value}
                onChange={(e) => setConversation({ ...conversation, value: e.target.value })}
              />
            </label>
            <button disabled={busy}>Save ID</button>
            <button type="button" onClick={() => setConversation(undefined)}>
              Cancel
            </button>
          </form>
        )}
        {selected && (
          <section className="session-preview">
            <div className="row">
              <strong>{selected.metadata.name}</strong>
              <button
                onClick={() => {
                  setHistory(null)
                }}
              >
                Current run
              </button>
              {selected.history.map((_, i) => (
                <button
                  key={i}
                  onClick={() =>
                    void perform(async () => {
                      const output = await sessionHistory(selected.id, i)
                      setHistory(i)
                      setHistoryOutput(
                        output
                          ? new TextDecoder().decode(
                              Uint8Array.from(atob(output.data), (c) => c.charCodeAt(0)),
                            )
                          : 'History unavailable',
                      )
                    })
                  }
                >
                  Run {i + 1}
                </button>
              ))}
              <button onClick={() => setSelected(undefined)}>Hide</button>
            </div>
            {history === null ? (
              <TerminalPane
                key={selected.id}
                existingSessionId={selected.id}
                componentId={selected.metadata.componentId}
                terminal={{
                  id: selected.metadata.terminalId,
                  name: selected.metadata.name,
                  command: '',
                  kind: selected.metadata.kind,
                }}
              />
            ) : (
              <pre>{historyOutput}</pre>
            )}
          </section>
        )}
        <div className="row">
          <span className="spacer" />
          <button
            onClick={() =>
              void perform(async () => {
                await flushWorkspace()
                await quitPatchbay()
              })
            }
          >
            Quit Patchbay
          </button>
          <button
            disabled={!connected || busy}
            onClick={() =>
              void perform(async () => {
                await flushWorkspace()
                await quitPatchbay(true)
              })
            }
          >
            Stop all work and quit
          </button>
        </div>
      </div>
    </div>
  )
}
