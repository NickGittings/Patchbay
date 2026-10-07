import { useEffect } from 'react'
import { ExtensionView } from '../extensions/views'
import { useExtensionViews } from '../extensions/useExtensionViews'
import { describeTerminal, statusTitle, terminalStatus } from '../lib/display'
import { useClockTick } from '../lib/clock'
import { useDockTabs } from '../lib/panels'
import { startTerminal, stopTerminal } from '../lib/sessions'
import { useStore } from '../store'
import StatusLabel from './status/StatusLabel'
import TerminalPane from './TerminalPane'

export default function TerminalDock() {
  const extensionViews = useExtensionViews('dock')
  const tabs = useDockTabs()
  const sessions = useStore((s) => s.sessions)
  useClockTick()
  const activeSession = useStore((s) => s.activeSession)
  const setActiveSession = useStore((s) => s.setActiveSession)
  const dockSession = useStore((s) => s.dockSession)
  const setDockSession = useStore((s) => s.setDockSession)
  const active =
    tabs.find((t) => t.sid === activeSession) ??
    tabs.find((t) => t.sid === dockSession) ??
    tabs[0] ??
    null
  const session = active ? sessions[active.sid] : undefined
  // Remember the shown session, so it stays listed once it exits.
  const activeSid = active?.sid
  useEffect(() => {
    if (activeSid) setDockSession(activeSid)
  }, [activeSid, setDockSession])
  // With no terminal to show, show an extension's view rather than an empty terminal.
  const view = extensionViews.selected ?? (active ? null : (extensionViews.views[0]?.id ?? null))

  return (
    <div className="panel terminal-dock">
      <div className="tabs">
        {tabs.map((t) => {
          const status = terminalStatus(t.terminal.kind, sessions[t.sid])
          return (
            <button
              key={t.sid}
              className={`tab health-${status.health} ${t.sid === active?.sid ? 'active' : ''}`}
              title={statusTitle(status)}
              onClick={() => {
                extensionViews.setSelected(null)
                setActiveSession(t.sid)
              }}
            >
              <span className="status-dot" />
              {t.label}
            </button>
          )
        })}
        {extensionViews.views.map((v) => (
          <button
            key={v.id}
            className={`tab ${v.id === view ? 'active' : ''}`}
            data-extension-view-tab={v.id}
            onClick={() => extensionViews.setSelected(v.id)}
          >
            {v.title}
          </button>
        ))}
        <span className="spacer" />
        {active && !view && (
          <span className="tab-actions">
            <StatusLabel status={terminalStatus(active.terminal.kind, session)} />
            <code>{describeTerminal(active.terminal)}</code>
            {session?.running ? (
              <button onClick={() => stopTerminal(active.sid)}>■ Stop</button>
            ) : (
              <button
                onClick={() =>
                  void startTerminal(active.componentId, active.terminal.id, active.task)
                }
              >
                ▶ {session ? 'Restart' : 'Start'}
              </button>
            )}
            {!session?.running && (
              <button
                className="dock-close"
                title="Close this exited terminal"
                onClick={() => setDockSession(null)}
              >
                Close
              </button>
            )}
          </span>
        )}
      </div>
      {view ? (
        <ExtensionView id={view} />
      ) : active ? (
        <TerminalPane
          key={active.sid}
          componentId={active.componentId}
          terminal={active.terminal}
          task={active.task}
        />
      ) : (
        <div className="terminal-area" />
      )}
    </div>
  )
}
