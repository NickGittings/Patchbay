import { useLayoutEffect, useRef } from 'react'
import { ExtensionView } from '../extensions/views'
import { useExtensionViews } from '../extensions/useExtensionViews'
import { describeTerminal, statusTitle, terminalStatus } from '../lib/display'
import { useClockTick } from '../lib/clock'
import { useDockTabs } from '../lib/panels'
import { useStore } from '../store'
import type { SessionRecord } from '../types'
import StatusLabel from './status/StatusLabel'
import TerminalPane from './TerminalPane'
import TerminalControl from './TerminalControl'

/** `collapsed`: the dock's panel is dragged shut, so no terminal is fitted to it. */
export default function TerminalDock({
  collapsed,
  agentTerminal,
  onCloseAgent,
}: {
  collapsed: boolean
  agentTerminal?: SessionRecord
  onCloseAgent: () => void
}) {
  const revealed = useStore((s) => s.dockReveal)
  const extensionViews = useExtensionViews('dock', revealed)
  const dockTabs = useDockTabs()
  // Keep the normal dock tab when it already shows the requested session.
  const extraAgent =
    agentTerminal && !dockTabs.some((t) => t.sid === agentTerminal.id) ? agentTerminal : undefined
  const tabs = extraAgent
    ? [
        ...dockTabs,
        {
          sid: extraAgent.id,
          componentId: extraAgent.metadata.componentId,
          terminal: {
            id: extraAgent.metadata.terminalId,
            name: extraAgent.metadata.name,
            kind: extraAgent.metadata.kind,
            command: extraAgent.spec.command,
          },
          label: extraAgent.metadata.name,
          task: extraAgent.metadata.task ?? null,
        },
      ]
    : dockTabs
  const sessions = useStore((s) => s.sessions)
  useClockTick()
  const activeSession = useStore((s) => s.activeSession)
  const setActiveSession = useStore((s) => s.setActiveSession)
  const dropFromDock = useStore((s) => s.dropFromDock)
  const active = tabs.find((t) => t.sid === activeSession) ?? tabs[0] ?? null
  const openedAgent = !!active && active.sid === extraAgent?.id
  const session = active ? sessions[active.sid] : undefined
  // With no terminal to show, show an extension's view rather than an empty terminal.
  const view = extensionViews.selected ?? (active ? null : (extensionViews.views[0]?.id ?? null))

  const strip = useRef<HTMLDivElement>(null)
  const activeTab = view ?? active?.sid
  useLayoutEffect(() => {
    const element = strip.current
    if (!element) return
    const reveal = () =>
      element.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(element)
    return () => observer.disconnect()
  }, [activeTab, revealed])

  return (
    <div className="panel terminal-dock">
      <div className="dock-header">
        <div className="tabs dock-tabs" ref={strip} aria-label="Dock tabs">
          {tabs.map((t) => {
            const status = terminalStatus(t.terminal.kind, sessions[t.sid])
            return (
              <button
                key={t.sid}
                data-dock-session={t.sid}
                className={`tab health-${status.health} ${!view && t.sid === active?.sid ? 'active' : ''}`}
                title={statusTitle(status, `${t.label} · ${describeTerminal(t.terminal)}`)}
                aria-description={statusTitle(status, t.label)}
                aria-pressed={!view && t.sid === active?.sid}
                onClick={() => {
                  extensionViews.setSelected(null)
                  setActiveSession(t.sid)
                }}
              >
                <span className="status-dot" />
                <span className="dock-tab-label">{t.label}</span>
              </button>
            )
          })}
          {extensionViews.views.map((v) => (
            <button
              key={v.id}
              className={`tab ${v.id === view ? 'active' : ''}`}
              data-extension-view-tab={v.id}
              title={v.title}
              aria-pressed={v.id === view}
              onClick={() => extensionViews.setSelected(v.id)}
            >
              <span className="dock-tab-label">{v.title}</span>
            </button>
          ))}
        </div>
        {active && !view && (
          <span className="tab-actions dock-actions">
            <StatusLabel status={terminalStatus(active.terminal.kind, session)} />
            <TerminalControl
              kind={active.terminal.kind}
              componentId={active.componentId}
              terminalId={active.terminal.id}
              sid={active.sid}
              session={session}
              task={active.task}
              existingOnly={openedAgent}
            />
            {(openedAgent || !session?.running) && (
              <button
                className="dock-close"
                title={
                  active.sid === agentTerminal?.id
                    ? 'Close this agent terminal'
                    : 'Close this exited terminal'
                }
                onClick={() => {
                  if (active.sid === agentTerminal?.id) onCloseAgent()
                  else dropFromDock(active.sid)
                }}
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
          existingSessionId={openedAgent ? active.sid : undefined}
        />
      ) : (
        <div className="terminal-area" />
      )}
    </div>
  )
}
