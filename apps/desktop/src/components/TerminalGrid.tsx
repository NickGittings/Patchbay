import { useState } from 'react'
import { describeTerminal, terminalStatus } from '../lib/display'
import { useClockTick } from '../lib/clock'
import { startTerminal, stopTerminal } from '../lib/sessions'
import { useStore } from '../store'
import { sessionId, type TerminalSpec } from '../types'
import StatusLabel from './status/StatusLabel'
import TerminalPane from './TerminalPane'
import EmptyState from './EmptyState'

/**
 * Shared tiled sessions for the implementation view and component pop-outs.
 * `maximized`/`onMaximize` let a parent showing several grids keep one tile
 * maximized across them.
 */
export default function TerminalGrid({
  componentId,
  terminals,
  maximized: controlled,
  onMaximize,
  onClose,
  emptyMessage = 'Add a dev server, test runner or agent using the “+ Add terminal…” menu above.',
}: {
  componentId: string
  terminals: TerminalSpec[]
  maximized?: string | null
  onMaximize?: (sid: string | null) => void
  onClose?: (terminalId: string) => Promise<boolean>
  emptyMessage?: string
}) {
  const sessions = useStore((s) => s.sessions)
  const task = useStore((s) => s.activeTask)
  const [local, setLocal] = useState<string | null>(null)
  const [closing, setClosing] = useState<string | null>(null)
  const maximized = onMaximize ? (controlled ?? null) : local
  const setMaximized = onMaximize ?? setLocal
  useClockTick()
  const sids = terminals.map((t) => sessionId(componentId, t.id, task))
  const solo = maximized && sids.includes(maximized) ? maximized : null
  return (
    <div className={`terminal-grid ${solo ? 'has-maximized' : ''}`}>
      {terminals.map((terminal, i) => {
        const sid = sids[i]
        if (solo && sid !== solo) return null
        const session = sessions[sid]
        const status = terminalStatus(terminal.kind, session)
        return (
          <section
            key={sid}
            className={`terminal-tile health-${status.health} ${solo ? 'maximized' : ''}`}
          >
            <div className="terminal-tile-header">
              <span className="status-dot" />
              <strong>{terminal.name}</strong>
              <StatusLabel status={status} />
              <code title={describeTerminal(terminal)}>{describeTerminal(terminal)}</code>
              {session?.running ? (
                <button onClick={() => stopTerminal(sid)}>■ Stop</button>
              ) : (
                <button onClick={() => void startTerminal(componentId, terminal.id, task)}>
                  ▶ {session ? 'Restart' : 'Start'}
                </button>
              )}
              <button
                title={solo ? 'Show all terminals' : 'Maximize this terminal'}
                aria-label={solo ? `Restore ${terminal.name}` : `Maximize ${terminal.name}`}
                aria-pressed={!!solo}
                onClick={() => setMaximized(solo ? null : sid)}
              >
                {solo ? '⤡' : '⤢'}
              </button>
              {onClose && (
                <button
                  className="terminal-close"
                  title={`Close ${terminal.name}`}
                  aria-label={`Close ${terminal.name}`}
                  disabled={closing !== null}
                  onClick={async () => {
                    setClosing(sid)
                    try {
                      if ((await onClose(terminal.id)) && maximized === sid) setMaximized(null)
                    } finally {
                      setClosing(null)
                    }
                  }}
                >
                  ×
                </button>
              )}
            </div>
            <TerminalPane componentId={componentId} terminal={terminal} focus={false} />
          </section>
        )
      })}
      {terminals.length === 0 && (
        <EmptyState icon="›_" title="No terminals">
          {emptyMessage}
        </EmptyState>
      )}
    </div>
  )
}
