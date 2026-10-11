import { useState } from 'react'
import { useStore } from '../store'
import {
  sessionConversation,
  sessionHistory,
  sessionForget,
  sessionResume,
  terminalStop,
  sessionsStopAll,
} from '../lib/ipc'
import { hydrateSession, reconcileSessions, startTerminal } from '../lib/sessions'
import { ago } from '../lib/review'
import { useClockTick } from '../lib/clock'
import {
  DEFAULT_SESSION_LIST_OPTIONS,
  groupByProject,
  projectSessions,
  sessionLive,
  type ProjectSessionChoices,
  type SessionFilter,
  type SessionListOptions,
  type SessionSort,
} from '../lib/sessionList'
import type { SessionRecord } from '../types'
import TerminalPane from './TerminalPane'

const EMPTY: Record<SessionFilter, string> = {
  all: 'No sessions',
  running: 'No running sessions',
  closed: 'No closed sessions',
}

/** A relative time that re-renders on the shared clock only while it is on screen. */
function Ago({ ms }: { ms: number }) {
  useClockTick()
  const date = new Date(ms)
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {ago(ms)}
    </time>
  )
}

export default function SessionsPanel() {
  const open = useStore((s) => s.sessionsPanelOpen)
  const records = useStore((s) => s.sessionRecords)
  const connected = useStore((s) => s.serviceConnected)
  const [choices, setChoices] = useState<ProjectSessionChoices>({})
  const choose = (projectId: string, patch: Partial<SessionListOptions>) =>
    setChoices((current) => ({
      ...current,
      [projectId]: { ...(current[projectId] ?? DEFAULT_SESSION_LIST_OPTIONS), ...patch },
    }))
  const [selected, setSelected] = useState<SessionRecord>()
  const [conversation, setConversation] = useState<{ id: string; value: string }>()
  const [historyOutput, setHistoryOutput] = useState('')
  const [history, setHistory] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmStopAll, setConfirmStopAll] = useState(false)
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
  const close = () => {
    setConfirmStopAll(false)
    useStore.setState({ sessionsPanelOpen: false })
  }
  if (!open) return null
  const groups = groupByProject(records)
  return (
    <div className="extension-overlay" onClick={close}>
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
          <button
            title="Stop work in every project, including sessions hidden by filters"
            disabled={!connected || busy}
            onClick={() => setConfirmStopAll(true)}
          >
            Stop all work
          </button>
          <button onClick={close}>Close</button>
        </div>
        <p>
          Closing tabs, windows, or quitting Patchbay leaves work running. Stop terminates it
          explicitly.
        </p>
        {confirmStopAll && (
          <section role="alertdialog" aria-label="Stop all work confirmation">
            <p>
              Stop every process in every project? This includes closed project tabs and sessions
              hidden by filters. In-progress graph actions will be cancelled. Output will be kept.
            </p>
            <div className="row">
              <button
                className="danger"
                disabled={!connected || busy}
                onClick={() => {
                  setConfirmStopAll(false)
                  void perform(sessionsStopAll)
                }}
              >
                Stop every project
              </button>
              <button disabled={busy} onClick={() => setConfirmStopAll(false)}>
                Cancel
              </button>
            </div>
          </section>
        )}
        {!records.length && <p>No retained sessions.</p>}
        <div className="session-list">
          {groups.map(({ projectId, projectName, records: group }) => {
            const chosen = choices[projectId] ?? DEFAULT_SESSION_LIST_OPTIONS
            // Running state is unknown while disconnected, so the filter shows everything.
            const options = connected ? chosen : { ...chosen, filter: 'all' as const }
            const visible = projectSessions(group, options)
            return (
              <section key={projectId}>
                <div className="row session-group-heading">
                  <h3>{projectName}</h3>
                  <span className="spacer" />
                  <label>
                    Show{' '}
                    <select
                      aria-label={`Filter sessions for ${projectName}`}
                      value={options.filter}
                      disabled={!connected}
                      onChange={(e) =>
                        choose(projectId, { filter: e.target.value as SessionFilter })
                      }
                    >
                      <option value="all">All</option>
                      <option value="running">Running</option>
                      <option value="closed">Closed</option>
                    </select>
                  </label>
                  <label>
                    Sort{' '}
                    <select
                      aria-label={`Sort sessions for ${projectName}`}
                      value={options.sort}
                      onChange={(e) => choose(projectId, { sort: e.target.value as SessionSort })}
                    >
                      <option value="latest">Newest first</option>
                      <option value="oldest">Oldest first</option>
                    </select>
                  </label>
                </div>
                {!visible.length && <p className="hint">{EMPTY[options.filter]}</p>}
                {visible.map(({ record: r, time }) => {
                  const live = sessionLive(r)
                  // Recorded but not spawned yet: output is not available to reconnect to.
                  const starting = live && !r.snapshot
                  return (
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
                          : starting
                            ? 'Starting'
                            : live
                              ? 'Running'
                              : r.interrupted
                                ? 'Interrupted'
                                : 'Ended'}
                      </span>
                      <small>{time !== undefined && <Ago ms={time} />}</small>
                      <button
                        disabled={!connected || busy || starting}
                        onClick={() =>
                          void perform(async () => {
                            await hydrateSession(r.id)
                            setSelected(r)
                            setHistory(null)
                          })
                        }
                      >
                        {live ? 'Reconnect' : 'View output'}
                      </button>
                      {live ? (
                        <button
                          title="Stop this session; cancel startup if its plan includes this session"
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
                  )
                })}
              </section>
            )
          })}
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
            <p className="hint">
              Launch folder:{' '}
              {history === null
                ? (selected.snapshot?.launchDirectory ?? selected.spec.cwd)
                : (selected.history[history]?.launchDirectory ?? 'Unknown (legacy history)')}
            </p>
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
      </div>
    </div>
  )
}
