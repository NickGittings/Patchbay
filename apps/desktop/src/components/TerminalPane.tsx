import { useEffect, useRef, useState } from 'react'
import { describeTerminal } from '../lib/display'
import { hydrateSession, startTerminal } from '../lib/sessions'
import { attach, fit } from '../lib/terminals'
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
    window.addEventListener('focus', refit)
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
      window.removeEventListener('focus', refit)
    }
  }, [sid, componentId, terminal.id, terminal.kind, focus])

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
