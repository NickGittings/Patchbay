import { useState } from 'react'
import { attentionItems, revealTerminal } from '../../lib/attention'
import { useClockTick } from '../../lib/clock'
import { useStore } from '../../store'

const SUMMARY: Record<string, string> = {
  input: 'need input',
  fail: 'failed',
  unhealthy: 'not responding',
  review: 'to review',
}

/** Toolbar summary of the terminals that want the user, most urgent first. */
export default function AttentionMenu() {
  const nodes = useStore((s) => s.nodes)
  const sessions = useStore((s) => s.sessions)
  useClockTick()
  const runtimeTerminals = useStore((s) => s.runtimeTerminals)
  const devices = useStore((s) => s.devices)
  const [open, setOpen] = useState(false)
  const items = attentionItems({ nodes, sessions, runtimeTerminals, devices })

  if (items.length === 0) return null
  const counts = new Map<string, number>()
  for (const item of items)
    counts.set(item.status.health, (counts.get(item.status.health) ?? 0) + 1)
  const summary = [...counts].map(([health, n]) => `${n} ${SUMMARY[health] ?? health}`).join(' · ')

  return (
    <div className="attention">
      <button
        className={`attention-button health-${items[0].status.health}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
        title={`Terminals that need you: ${summary}`}
      >
        <span className="status-dot" />
        <span className="attention-summary">{summary}</span>
      </button>
      {open && (
        <>
          <div className="attention-overlay" onClick={() => setOpen(false)} />
          <div className="attention-list" role="menu">
            {items.map((item) => (
              <button
                key={item.sid}
                role="menuitem"
                className={`attention-item health-${item.status.health}`}
                onClick={() => {
                  setOpen(false)
                  revealTerminal(item)
                }}
              >
                <span className="status-dot" />
                <span className="attention-what">
                  <span>
                    <strong>{item.owner}</strong> · {item.terminal.name}
                  </span>
                  {item.status.detail && <small>{item.status.detail}</small>}
                </span>
                <span className="attention-label">{item.status.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
