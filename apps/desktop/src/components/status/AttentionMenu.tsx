import { attentionItems, revealTerminal } from '../../lib/attention'
import { useClockTick } from '../../lib/clock'
import { focusTerminal } from '../../lib/terminals'
import { useStore } from '../../store'
import Menu, { MenuItem } from '../Menu'

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
  const items = attentionItems({ nodes, sessions, runtimeTerminals, devices })

  if (items.length === 0) return null
  const counts = new Map<string, number>()
  for (const item of items)
    counts.set(item.status.health, (counts.get(item.status.health) ?? 0) + 1)
  const summary = [...counts].map(([health, n]) => `${n} ${SUMMARY[health] ?? health}`).join(' · ')

  return (
    <Menu
      className="attention"
      align="right"
      caret={false}
      triggerClassName={`attention-button health-${items[0].status.health}`}
      listClassName="attention-list"
      title={`Terminals that need you: ${summary}`}
      label={
        <>
          <span className="status-dot" />
          <span className="attention-summary">{summary}</span>
        </>
      }
    >
      {items.map((item) => (
        <MenuItem
          key={item.sid}
          className={`attention-item health-${item.status.health}`}
          onClick={() => {
            revealTerminal(item)
            // After the view switch renders, so typing answers the revealed terminal.
            requestAnimationFrame(() => focusTerminal(item.sid))
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
        </MenuItem>
      ))}
    </Menu>
  )
}
