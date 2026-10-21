import { ExtensionView } from '../extensions/views'
import { useExtensionViews } from '../extensions/useExtensionViews'
import { describeTerminal, statusTitle, terminalStatus } from '../lib/display'
import { useClockTick } from '../lib/clock'
import { useDockTabs } from '../lib/panels'
import { useStore } from '../store'
import StatusLabel from './status/StatusLabel'
import TerminalPane from './TerminalPane'
import TerminalControl from './TerminalControl'

/** `collapsed`: the dock's panel is dragged shut, so no terminal is fitted to it. */
export default function TerminalDock({ collapsed }: { collapsed: boolean }) {
  const extensionViews = useExtensionViews('dock')
  const tabs = useDockTabs()
  const sessions = useStore((s) => s.sessions)
  useClockTick()
  const activeSession = useStore((s) => s.activeSession)
  const setActiveSession = useStore((s) => s.setActiveSession)
  const dropFromDock = useStore((s) => s.dropFromDock)
  const active = tabs.find((t) => t.sid === activeSession) ?? tabs[0] ?? null
  const session = active ? sessions[active.sid] : undefined
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
              className={`tab health-${status.health} ${!view && t.sid === active?.sid ? 'active' : ''}`}
              title={statusTitle(status, describeTerminal(t.terminal))}
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
            <TerminalControl
              componentId={active.componentId}
              terminalId={active.terminal.id}
              sid={active.sid}
              session={session}
              task={active.task}
            />
            {!session?.running && (
              <button
                className="dock-close"
                title="Close this exited terminal"
                onClick={() => dropFromDock(active.sid)}
              >
                Close
              </button>
            )}
          </span>
        )}
      </div>
      {view ? (
        <ExtensionView id={view} />
      ) : active && !collapsed ? (
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
