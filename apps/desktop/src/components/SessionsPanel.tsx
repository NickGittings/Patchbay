import { createPortal } from 'react-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { projectStateOf, useStore } from '../store'
import {
  sessionConversation,
  sessionHistory,
  sessionForget,
  sessionResume,
  terminalStop,
  sessionsStopAll,
  taskList,
} from '../lib/ipc'
import { hydrateSession, reconcileSessions, startTerminal } from '../lib/sessions'
import { ago } from '../lib/review'
import { useClockTick } from '../lib/clock'
import {
  DEFAULT_SESSION_LIST_OPTIONS,
  groupByProject,
  groupByWorktree,
  sessionLive,
  sessionRole,
  subject,
  type ProjectSessionChoices,
  type SessionFilter,
  type SessionListOptions,
  type SessionSort,
} from '../lib/sessionList'
import { sessionView, type SessionRecord, type Task } from '../types'
import { revealTerminal } from '../lib/attention'
import Menu, { MenuItem, MenuSeparator } from './Menu'
import TerminalPane from './TerminalPane'
import TerminalControl from './TerminalControl'

const EMPTY: Record<SessionFilter, string> = {
  all: 'No sessions',
  running: 'No running sessions',
  closed: 'No closed sessions',
}
/** Worktree counts follow the filter, so they never read as the worktree's whole history. */
const COUNTED: Record<SessionFilter, string> = { all: '', running: 'running ', closed: 'closed ' }

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

function SessionTitle({ metadata }: { metadata: SessionRecord['metadata'] }) {
  const { role, tone } = sessionRole(metadata)
  const label = subject(metadata)
  return (
    <strong className="session-title">
      <span className={`session-role ${tone}`}>{role}</span>{' '}
      <span>
        {label && `${label} · `}
        <span className="session-name">{metadata.name}</span>
      </span>
    </strong>
  )
}

interface SessionListProps {
  choices: ProjectSessionChoices
  choose: (projectId: string, patch: Partial<SessionListOptions>) => void
  connected: boolean
  busy: boolean
  perform: (action: () => Promise<unknown>) => Promise<void>
  onSelect: (record: SessionRecord) => void
  onReveal: (record: SessionRecord) => void
  onConversation: (conversation: { id: string; value: string }) => void
}

/** Mounted only while the panel is open; subscriptions and legacy lookups stop on close. */
function SessionList({
  choices,
  choose,
  connected,
  busy,
  perform,
  onSelect,
  onReveal,
  onConversation,
}: SessionListProps) {
  const records = useStore((s) => s.sessionRecords)
  const groups = useMemo(() => groupByProject(records), [records])
  const projectTasks: Record<string, Task[] | undefined> = useStore(
    useShallow((s) =>
      Object.fromEntries(
        groups.map(({ projectId }) => [projectId, projectStateOf(projectId, s)?.tasks]),
      ),
    ),
  )
  const [loadedTasks, setLoadedTasks] = useState<Record<string, Task[]>>({})
  // New records carry their own title. Only older records need a read-only Tauri lookup.
  const legacyIds = groups
    .filter(
      ({ projectId, records }) =>
        projectTasks[projectId] !== undefined &&
        records.some(
          ({ metadata }) =>
            metadata.task &&
            !metadata.taskTitle &&
            !projectTasks[projectId]?.some((t) => t.id === metadata.task),
        ),
    )
    .map(({ projectId }) => projectId)
    .sort()
    .join('\n')
  useEffect(() => {
    let cancelled = false
    if (legacyIds)
      for (const id of legacyIds.split('\n')) {
        void taskList(id)
          .then((tasks) => {
            if (!cancelled) setLoadedTasks((current) => ({ ...current, [id]: tasks }))
          })
          .catch(() => {})
      }
    return () => {
      cancelled = true
    }
  }, [legacyIds])
  return (
    <>
      {!records.length && <p>No retained sessions.</p>}
      <div className="session-list">
        {groups.map(({ projectId, projectName, records: group }) => {
          const chosen = choices[projectId] ?? DEFAULT_SESSION_LIST_OPTIONS
          // Running state is unknown while disconnected, so the filter shows everything.
          const options = connected ? chosen : { ...chosen, filter: 'all' as const }
          const visible = groupByWorktree(group, options, [
            ...(loadedTasks[projectId] ?? []),
            ...(projectTasks[projectId] ?? []),
          ])
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
                    onChange={(e) => choose(projectId, { filter: e.target.value as SessionFilter })}
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
              {visible.map((worktree) => (
                <section
                  className="session-worktree"
                  key={worktree.task === null ? 'main' : `task:${worktree.task}`}
                >
                  <div className="session-worktree-heading">
                    <div className="session-worktree-label">
                      <span className="session-worktree-eyebrow">
                        {worktree.task === null ? 'PROJECT FOLDER' : 'WORKTREE'}
                      </span>
                      <div className="row">
                        <h4>{worktree.title}</h4>
                        {worktree.branch && (
                          <span className="session-worktree-branch mono">{worktree.branch}</span>
                        )}
                        <span className="session-worktree-count">
                          {worktree.rows.length} {COUNTED[options.filter]}
                          {worktree.rows.length === 1 ? 'session' : 'sessions'}
                        </span>
                      </div>
                    </div>
                    {worktree.path && (
                      <small className="session-worktree-path mono">{worktree.path}</small>
                    )}
                  </div>
                  <div className="session-worktree-rows">
                    {worktree.rows.map(({ record: r, time }) => {
                      const live = sessionLive(r)
                      // Recorded but not spawned yet: output is not available to reconnect to.
                      const starting = live && !r.snapshot
                      const review = sessionView(r.metadata.componentId) === 'review'
                      const unavailable = !connected || busy
                      // Review sessions are reopened in Review rather than started again.
                      const reopen = {
                        label: review ? 'Show in Review' : 'Start new',
                        // Both need the project open: Review reveals in the active project.
                        disabled: unavailable || projectTasks[projectId] === undefined,
                        onClick: () =>
                          void perform(async () => {
                            useStore.getState().activateProject(r.metadata.projectId)
                            if (review) {
                              onReveal(r)
                              return
                            }
                            await startTerminal(
                              r.metadata.componentId,
                              r.metadata.terminalId,
                              r.metadata.task ?? null,
                              r.metadata.projectId,
                            )
                          }),
                      }
                      // Two inline actions at most; a finished review without Resume shows its way
                      // back inline, since that is the row's main action.
                      const reviewInline = review && !live && !r.metadata.adapter
                      return (
                        <div className="session-row" key={r.id}>
                          <div>
                            <SessionTitle metadata={r.metadata} />
                            <small className="mono">{r.spec.cwd}</small>
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
                            disabled={unavailable || starting}
                            onClick={() =>
                              void perform(async () => {
                                await hydrateSession(r.id)
                                onSelect(r)
                              })
                            }
                          >
                            {live ? 'Reconnect' : 'View output'}
                          </button>
                          {live ? (
                            <button
                              title="Stop this session; cancel startup if its plan includes this session"
                              disabled={unavailable}
                              onClick={() => void perform(() => terminalStop(r.id))}
                            >
                              Stop
                            </button>
                          ) : r.metadata.adapter ? (
                            <button
                              disabled={unavailable}
                              onClick={() => void perform(() => sessionResume(r.id))}
                            >
                              Resume
                            </button>
                          ) : (
                            reviewInline && (
                              <button disabled={reopen.disabled} onClick={reopen.onClick}>
                                {reopen.label}
                              </button>
                            )
                          )}
                          {(!live || r.metadata.adapter) && (
                            <Menu
                              label="⋯"
                              title="More session actions"
                              triggerLabel={`More actions for ${r.metadata.name}`}
                              caret={false}
                              portal
                              align="right"
                              className="session-menu"
                              listClassName="session-menu-list"
                            >
                              {!live && !reviewInline && (
                                <MenuItem disabled={reopen.disabled} onClick={reopen.onClick}>
                                  {reopen.label}
                                </MenuItem>
                              )}
                              {r.metadata.adapter && (
                                <MenuItem
                                  disabled={unavailable}
                                  onClick={() =>
                                    onConversation({
                                      id: r.id,
                                      value: r.metadata.conversationId ?? '',
                                    })
                                  }
                                >
                                  Set conversation ID…
                                </MenuItem>
                              )}
                              {!live && (
                                <>
                                  {!reviewInline && <MenuSeparator />}
                                  <MenuItem
                                    disabled={unavailable}
                                    onClick={() => void perform(() => sessionForget(r.id))}
                                  >
                                    Forget
                                  </MenuItem>
                                </>
                              )}
                            </Menu>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>
              ))}
            </section>
          )
        })}
      </div>
    </>
  )
}

/** Keep choices and preview selection while the dock is closed; mount its content in the dock. */
export default function SessionsPanel({ host }: { host: HTMLElement | null }) {
  const open = useStore((s) => s.sessionsPanelOpen)
  const connected = useStore((s) => s.sessionsPanelOpen && s.serviceConnected)
  const [choices, setChoices] = useState<ProjectSessionChoices>({})
  const choose = (projectId: string, patch: Partial<SessionListOptions>) =>
    setChoices((current) => ({
      ...current,
      [projectId]: { ...(current[projectId] ?? DEFAULT_SESSION_LIST_OPTIONS), ...patch },
    }))
  const [selected, setSelected] = useState<SessionRecord>()
  const selectedSession = useStore((s) => (selected ? s.sessions[selected.id] : undefined))
  const selectedProjectOpen = useStore(
    (s) => !!selected && projectStateOf(selected.metadata.projectId, s) !== undefined,
  )
  const [conversation, setConversation] = useState<{ id: string; value: string }>()
  const [historyOutput, setHistoryOutput] = useState('')
  const [history, setHistory] = useState<number | null>(null)
  const preview = useRef<HTMLElement>(null)
  useEffect(() => {
    if (open && selected) preview.current?.scrollIntoView({ block: 'nearest' })
  }, [open, selected, history, host])
  // The run chosen in the select, ahead of its output loading; `history` follows once it has.
  const [requested, setRequested] = useState<number | null>(null)
  // Bumped per choice, so a slower earlier fetch can't replace a later choice's output.
  const historyRequest = useRef(0)
  const [busy, setBusy] = useState(false)
  const [confirmStopAll, setConfirmStopAll] = useState(false)
  useEffect(
    () =>
      useStore.subscribe((s, previous) => {
        if (previous.sessionsPanelOpen && !s.sessionsPanelOpen) setConfirmStopAll(false)
      }),
    [],
  )
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
  if (!open || !host) return null
  return createPortal(
    <div className="utility-content">
      <div
        className="sessions-panel panel"
        role="region"
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
        <SessionList
          choices={choices}
          choose={choose}
          connected={connected}
          busy={busy}
          perform={perform}
          onSelect={(record) => {
            historyRequest.current++
            setSelected(record)
            setHistory(null)
            setRequested(null)
          }}
          onReveal={(r) => {
            revealTerminal({ sid: r.id, componentId: r.metadata.componentId })
            close()
          }}
          onConversation={setConversation}
        />
        {conversation && (
          <form
            // Remounts per session, so choosing another row's menu item focuses its input again.
            key={conversation.id}
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
                // Opened from a row's menu, possibly far above this form in a scrolling list.
                autoFocus
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
          <section className="session-preview" ref={preview}>
            <div className="row">
              <SessionTitle metadata={selected.metadata} />
              {!!selected.history.length && (
                <select
                  aria-label="Run"
                  value={requested ?? ''}
                  onChange={(e) => {
                    const request = ++historyRequest.current
                    if (e.target.value === '') {
                      setRequested(null)
                      setHistory(null)
                      return
                    }
                    const i = Number(e.target.value)
                    const shown = history
                    setRequested(i)
                    // A read only: no `perform`, so row actions stay enabled and nothing reconciles.
                    void sessionHistory(selected.id, i).then(
                      (output) => {
                        if (request !== historyRequest.current) return
                        setHistory(i)
                        setHistoryOutput(
                          output
                            ? new TextDecoder().decode(
                                Uint8Array.from(atob(output.data), (c) => c.charCodeAt(0)),
                              )
                            : 'History unavailable',
                        )
                      },
                      (error: unknown) => {
                        // Show the run still on screen, so choosing the failed one again retries.
                        if (request === historyRequest.current) setRequested(shown)
                        useStore.getState().setMessage(String(error))
                      },
                    )
                  }}
                >
                  <option value="">Current run</option>
                  {selected.history.map((_, i) => (
                    <option key={i} value={i}>
                      Run {i + 1}
                    </option>
                  ))}
                </select>
              )}
              {history === null && (
                <TerminalControl
                  componentId={selected.metadata.componentId}
                  terminalId={selected.metadata.terminalId}
                  sid={selected.id}
                  session={selectedSession}
                  task={selected.metadata.task ?? null}
                  projectId={selected.metadata.projectId}
                  disabled={
                    !connected || busy || (!selectedSession?.running && !selectedProjectOpen)
                  }
                />
              )}
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
    </div>,
    host,
  )
}
