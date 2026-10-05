import { useEffect, useRef, useState } from 'react'
import { describeTerminal, terminalStatus } from '../lib/display'
import { terminalSeen, terminalAttach, terminalDetach } from '../lib/ipc'
import { hydrateSession, startTerminal } from '../lib/sessions'
import { attach, detachHost, fit } from '../lib/terminals'
import { ACTIVE_CHANGED } from '../lib/windows'
import { useStore } from '../store'
import { sessionId, type TerminalSpec } from '../types'

/** Shared xterm host with snapshot replay, sizing and first-use shell startup. */
export default function TerminalPane({
  componentId,
  terminal,
  focus = true,
  existingSessionId,
}: {
  componentId: string
  terminal: TerminalSpec
  focus?: boolean
  existingSessionId?: string
}) {
  const sid = existingSessionId ?? sessionId(componentId, terminal.id)
  const connected = useStore((s) => s.serviceConnected)
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
    window.addEventListener('patchbay:reconnected', refit)
    document.addEventListener('visibilitychange', refit)
    void hydrateSession(sid)
      .then((snapshot) => {
        if (disposed) return
        setReady(true)
        if (
          !existingSessionId &&
          useStore.getState().serviceConnected &&
          !snapshot &&
          terminal.kind === 'shell' &&
          !useStore.getState().sessions[sid]
        ) {
          void startTerminal(componentId, terminal.id)
        }
        refit()
      })
      .catch((e) => useStore.getState().setMessage(String(e)))
    return () => {
      disposed = true
      observer.disconnect()
      if (!detachHost(sid, host)) void terminalDetach(sid).catch(() => {})
      window.removeEventListener('patchbay:reconnected', refit)
      document.removeEventListener('visibilitychange', refit)
      window.removeEventListener(ACTIVE_CHANGED, refit)
    }
  }, [sid, componentId, terminal.id, terminal.kind, focus, existingSessionId])

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
          Disconnected · reconnecting to session service…
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
      {connected && ready && !session && terminal.kind !== 'shell' && (
        <div className="terminal-overlay">
          <button className="primary" onClick={() => void startTerminal(componentId, terminal.id)}>
            ▶ Start {describeTerminal(terminal)}
          </button>
        </div>
      )}
    </div>
  )
}
