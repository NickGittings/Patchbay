import { useEffect, useRef, useState } from 'react'
import { terminalStatus } from '../lib/display'
import { terminalSeen, terminalAttach, terminalDetach } from '../lib/ipc'
import { hydrateSession, startTerminal } from '../lib/sessions'
import { attach, detachHost, fit } from '../lib/terminals'
import { ACTIVE_CHANGED } from '../lib/windows'
import { useStore } from '../store'
import { isReviewAgentScope, TASK_ROOT_SCOPE, sessionId, type TerminalSpec } from '../types'

/**
 * Shared xterm host with snapshot replay, sizing and first-use shell startup. Shows the session of
 * `task` (by default the active task; `null` for the open worktree, as extension terminals are).
 */
export default function TerminalPane({
  componentId,
  terminal,
  focus = true,
  task: taskProp,
  existingSessionId,
}: {
  componentId: string
  terminal: TerminalSpec
  focus?: boolean
  /** The task whose worktree it runs in; defaults to the active task (`null`: the project's). */
  task?: string | null
  /** Show this exact session (e.g. from the Sessions panel) instead of deriving its id. */
  existingSessionId?: string
}) {
  const activeTask = useStore((s) => s.activeTask)
  const task = taskProp === undefined ? activeTask : taskProp
  const sid = existingSessionId ?? sessionId(componentId, terminal.id, task)
  const connected = useStore((s) => s.serviceConnected)
  const serviceError = useStore((s) => s.serviceError)
  const session = useStore((s) => s.sessions[sid])
  const unseen = terminalStatus(terminal.kind, session).unseenSince
  const hostRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  // Dismissal lasts for one run; a restart shows its own notice again.
  const [dismissed, setDismissed] = useState<number>()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    attach(sid, host, { focus })
    // Becoming visible or active (re)claims the PTY; resizing only refits.
    const refit = () => {
      attach(sid, host, { focus: false })
      if (document.visibilityState === 'visible')
        void terminalAttach(sid, document.hasFocus())
          .then(() => fit(sid))
          .catch(() => {})
      else void terminalDetach(sid).catch(() => {})
    }
    const observer = new ResizeObserver(() => attach(sid, host, { focus: false }))
    observer.observe(host)
    // Fires when this or another window gains focus, which can move PTY sizing here.
    window.addEventListener(ACTIVE_CHANGED, refit)
    document.addEventListener('visibilitychange', refit)
    // Hydration fails while the service is disconnected; reconnecting retries it.
    let hydrated = false
    const load = () =>
      hydrateSession(sid)
        .then((snapshot) => {
          if (disposed || hydrated) return
          hydrated = true
          setReady(true)
          if (
            !existingSessionId &&
            useStore.getState().serviceConnected &&
            !snapshot &&
            terminal.kind === 'shell' &&
            componentId !== TASK_ROOT_SCOPE &&
            !useStore.getState().sessions[sid]
          ) {
            void startTerminal(componentId, terminal.id, task)
          }
          refit()
        })
        .catch((e) => {
          if (!disposed && useStore.getState().serviceConnected)
            useStore.getState().setMessage(String(e))
        })
    const reconnected = () => {
      if (hydrated) refit()
      else void load()
    }
    window.addEventListener('patchbay:reconnected', reconnected)
    void load()
    return () => {
      disposed = true
      observer.disconnect()
      if (!detachHost(sid, host)) void terminalDetach(sid).catch(() => {})
      window.removeEventListener('patchbay:reconnected', reconnected)
      document.removeEventListener('visibilitychange', refit)
      window.removeEventListener(ACTIVE_CHANGED, refit)
    }
  }, [sid, componentId, terminal.id, terminal.kind, focus, existingSessionId, task])

  // Showing a session in a focused window acknowledges it in every window.
  useEffect(() => {
    if (unseen === undefined) return
    const markSeen = () => {
      if (document.hasFocus()) terminalSeen(sid).catch(() => {})
    }
    markSeen()
    window.addEventListener('focus', markSeen)
    return () => window.removeEventListener('focus', markSeen)
  }, [sid, unseen])

  return (
    <div className="terminal-area">
      {!connected && (
        <div className="terminal-notice" role="status">
          {serviceError?.includes('protocol mismatch')
            ? 'An older Patchbay session service is still running (its work is preserved). Stop it with `patchbay sessions shutdown` from the matching version; Patchbay then starts a new one.'
            : 'Disconnected · reconnecting to session service…'}
        </div>
      )}
      {session?.truncated && (
        <div className="terminal-notice">Earlier output was truncated (512 KiB history limit).</div>
      )}
      {session?.interrupted && (
        <div className="terminal-notice">
          Interrupted · the service restarted. Recovery is explicit.
        </div>
      )}
      {session?.notice && dismissed !== session.startedMs && (
        <div className="terminal-notice" role="status">
          <span>{session.notice}</span>
          <button title="Dismiss" onClick={() => setDismissed(session.startedMs)}>
            ×
          </button>
        </div>
      )}
      <div className="terminal-host" ref={hostRef} />
      {connected &&
        ready &&
        !session &&
        !isReviewAgentScope(componentId) &&
        (terminal.kind !== 'shell' || componentId === TASK_ROOT_SCOPE) && (
          <div className="terminal-overlay">
            <button
              className="primary"
              onClick={() => void startTerminal(componentId, terminal.id, task)}
            >
              ▶ Start {terminal.name}
            </button>
            {terminal.kind !== 'agent' && terminal.command && (
              <code className="terminal-overlay-command" title={terminal.command}>
                {terminal.command}
              </code>
            )}
          </div>
        )}
    </div>
  )
}
