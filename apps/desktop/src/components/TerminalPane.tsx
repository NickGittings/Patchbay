import { useEffect, useRef, useState } from 'react'
import { describeTerminal, terminalStatus } from '../lib/display'
import { terminalSeen } from '../lib/ipc'
import { hydrateSession, startTerminal } from '../lib/sessions'
import { attach, fit } from '../lib/terminals'
import { ACTIVE_CHANGED } from '../lib/windows'
import { useStore } from '../store'
import { sessionId, type TerminalSpec } from '../types'

/** Shared xterm host with snapshot replay, sizing and first-use shell startup. */
export default function TerminalPane({
  componentId,
  terminal,
  focus = true,
}: {
  componentId: string
  terminal: TerminalSpec
  focus?: boolean
}) {
  const sid = sessionId(componentId, terminal.id)
  const session = useStore((s) => s.sessions[sid])
  // When a finished review or a failure that no window has shown yet happened.
  const { health, attention } = terminalStatus(terminal.kind, session)
  const unseen =
    attention === 0
      ? undefined
      : health === 'review'
        ? session?.status?.agent?.sinceMs
        : health === 'fail'
          ? session?.exitedMs
          : undefined
  const hostRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    attach(sid, host, { focus })
    const refit = () => fit(sid)
    const observer = new ResizeObserver(refit)
    observer.observe(host)
    // Fires when this or another window gains focus, which can move PTY sizing here.
    window.addEventListener(ACTIVE_CHANGED, refit)
    void hydrateSession(sid)
      .then((snapshot) => {
        if (disposed) return
        setReady(true)
        if (!snapshot && terminal.kind === 'shell' && !useStore.getState().sessions[sid]) {
          void startTerminal(componentId, terminal.id)
        }
        refit()
      })
      .catch((e) => useStore.getState().setMessage(String(e)))
    return () => {
      disposed = true
      observer.disconnect()
      window.removeEventListener(ACTIVE_CHANGED, refit)
    }
  }, [sid, componentId, terminal.id, terminal.kind, focus])

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
      <div className="terminal-host" ref={hostRef} />
      {ready && !session && terminal.kind !== 'shell' && (
        <div className="terminal-overlay">
          <button className="primary" onClick={() => void startTerminal(componentId, terminal.id)}>
            ▶ Start {describeTerminal(terminal)}
          </button>
        </div>
      )}
    </div>
  )
}
