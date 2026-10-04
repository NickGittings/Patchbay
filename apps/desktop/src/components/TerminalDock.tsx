import { ExtensionView } from '../extensions/views'
import { useExtensionViews } from '../extensions/useExtensionViews'
import { describeTerminal, statusTitle, terminalStatus } from '../lib/display'
import { useClockTick } from '../lib/clock'
import { startTerminal, stopTerminal } from '../lib/sessions'
import { useStore } from '../store'
import { sessionId, type TerminalSpec } from '../types'
import StatusLabel from './status/StatusLabel'
import TerminalPane from './TerminalPane'

interface Tab {
  sid: string
  componentId: string
  terminal: TerminalSpec
  label: string
}

/** Tabs for the selected component's terminals, or every started session when nothing is selected. */
function useTabs(): Tab[] {
  const nodes = useStore((s) => s.nodes)
  const selectedId = useStore((s) => s.selectedId)
  const sessions = useStore((s) => s.sessions)
  useClockTick()

  const runtime = useStore((s) => s.runtimeTerminals)
  const all = nodes.flatMap((n) =>
    n.data.terminals.map((t) => ({
      sid: sessionId(n.id, t.id),
      componentId: n.id,
      terminal: t,
      label: selectedId ? t.name : `${n.data.name} · ${t.name}`,
    })),
  )
  all.push(
    ...Object.entries(runtime)
      .filter(([, t]) => t.projectId === useStore.getState().project?.id)
      .map(([sid, t]) => ({
        sid,
        componentId: t.componentId,
        terminal: t.terminal,
        label: t.terminal.name,
      })),
  )
  return selectedId
    ? all.filter((t) => t.componentId === selectedId)
    : all.filter((t) => sessions[t.sid])
}

export default function TerminalDock() {
  const extensionViews = useExtensionViews('dock')
  const tabs = useTabs()
  const sessions = useStore((s) => s.sessions)
  useClockTick()
  const activeSession = useStore((s) => s.activeSession)
  const setActiveSession = useStore((s) => s.setActiveSession)
  const active = tabs.find((t) => t.sid === activeSession) ?? null
  const session = active ? sessions[active.sid] : undefined

  return (
    <div className="panel terminal-dock">
      <div className="tabs">
        {tabs.map((t) => {
          const status = terminalStatus(t.terminal.kind, sessions[t.sid])
          return (
            <button
              key={t.sid}
              className={`tab health-${status.health} ${t.sid === activeSession ? 'active' : ''}`}
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
        {extensionViews.views.map((view) => (
          <button
            key={view.id}
            className="tab"
            data-extension-view-tab={view.id}
            onClick={() => extensionViews.setSelected(view.id)}
          >
            {view.title}
          </button>
        ))}
        {tabs.length === 0 && (
          <span className="hint">Select a component to see its terminals.</span>
        )}
        <span className="spacer" />
        {active && !extensionViews.selected && (
          <span className="tab-actions">
            <StatusLabel status={terminalStatus(active.terminal.kind, session)} />
            <code>{describeTerminal(active.terminal)}</code>
            {session?.running ? (
              <button onClick={() => stopTerminal(active.sid)}>■ Stop</button>
            ) : (
              <button onClick={() => void startTerminal(active.componentId, active.terminal.id)}>
                ▶ {session ? 'Restart' : 'Start'}
              </button>
            )}
          </span>
        )}
      </div>
      {extensionViews.selected ? (
        <ExtensionView id={extensionViews.selected} />
      ) : active ? (
        <TerminalPane
          key={active.sid}
          componentId={active.componentId}
          terminal={active.terminal}
        />
      ) : (
        <div className="terminal-area" />
      )}
    </div>
  )
}
