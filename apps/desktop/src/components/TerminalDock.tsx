import { useEffect, useRef } from 'react'
import { describeTerminal, terminalHealth } from '../lib/display'
import { startTerminal, stopTerminal } from '../lib/sessions'
import { attach, fit } from '../lib/terminals'
import { useStore } from '../store'
import { sessionId } from '../types'

interface Tab {
  sid: string
  componentId: string
  terminalId: string
  label: string
  detail: string
  autoStart: boolean
}

/** Tabs for the selected component's terminals, or every started session when nothing is selected. */
function useTabs(): Tab[] {
  const nodes = useStore((s) => s.nodes)
  const selectedId = useStore((s) => s.selectedId)
  const sessions = useStore((s) => s.sessions)

  const all = nodes.flatMap((n) =>
    n.data.terminals.map((t) => ({
      sid: sessionId(n.id, t.id),
      componentId: n.id,
      terminalId: t.id,
      label: selectedId ? t.name : `${n.data.name} · ${t.name}`,
      detail: describeTerminal(t),
      autoStart: t.kind === 'shell',
    })),
  )
  return selectedId
    ? all.filter((t) => t.componentId === selectedId)
    : all.filter((t) => sessions[t.sid])
}

export default function TerminalDock() {
  const tabs = useTabs()
  const sessions = useStore((s) => s.sessions)
  const activeSession = useStore((s) => s.activeSession)
  const setActiveSession = useStore((s) => s.setActiveSession)
  const hostRef = useRef<HTMLDivElement>(null)

  const active = tabs.find((t) => t.sid === activeSession) ?? null
  const session = active ? sessions[active.sid] : undefined

  const activeSid = active?.sid
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (!active) {
      host.replaceChildren()
      return
    }
    attach(active.sid, host)
    // Shells start the first time you look at them.
    if (active.autoStart && !useStore.getState().sessions[active.sid]) {
      void startTerminal(active.componentId, active.terminalId)
    }
    // Re-run only when the visible session changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSid])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(() => {
      const id = useStore.getState().activeSession
      if (id) fit(id)
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="panel terminal-dock">
      <div className="tabs">
        {tabs.map((t) => (
          <button
            key={t.sid}
            className={`tab health-${terminalHealth(sessions[t.sid])} ${
              t.sid === activeSession ? 'active' : ''
            }`}
            onClick={() => setActiveSession(t.sid)}
          >
            <span className="status-dot" />
            {t.label}
          </button>
        ))}
        {tabs.length === 0 && (
          <span className="hint">Select a component to see its terminals.</span>
        )}
        <span className="spacer" />
        {active && (
          <span className="tab-actions">
            <code>{active.detail}</code>
            {session?.running ? (
              <button onClick={() => stopTerminal(active.sid)}>■ Stop</button>
            ) : (
              <button onClick={() => void startTerminal(active.componentId, active.terminalId)}>
                ▶ {session ? 'Restart' : 'Start'}
              </button>
            )}
          </span>
        )}
      </div>
      <div className="terminal-area">
        <div className="terminal-host" ref={hostRef} />
        {active && !session && !active.autoStart && (
          <div className="terminal-overlay">
            <button
              className="primary"
              onClick={() => void startTerminal(active.componentId, active.terminalId)}
            >
              ▶ Start {active.detail}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
