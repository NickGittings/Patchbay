import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { PLAN_SCOPE, type SessionRecord } from '../types'
import { terminalStatus } from '../lib/display'
import { useSimpleUi, EMPTY_SIMPLE_UI } from '../lib/simpleUi'
import StatusLabel from './status/StatusLabel'
import TerminalPane from './TerminalPane'

const attention = new Map<string, string>()
export default function SimpleAgent({
  record,
  scopeKey,
  openTerminal,
}: {
  record: SessionRecord
  scopeKey: string
  openTerminal: (r: SessionRecord) => void
}) {
  const session = useStore((s) => s.sessions[record.id])
  const expanded = useSimpleUi((s) =>
    (s.worktrees[scopeKey] ?? EMPTY_SIMPLE_UI).expanded.includes(record.id),
  )
  const host = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = host.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const agent = session?.status?.agent
    if (agent?.state !== 'needsInput') return
    const key = `${session?.generation}:${agent.sinceMs}`
    if (attention.get(record.id) === key) return
    attention.set(record.id, key)
    const ui = useSimpleUi.getState()
    const current = ui.worktrees[scopeKey] ?? EMPTY_SIMPLE_UI
    if (!current.expanded.includes(record.id))
      ui.patch(scopeKey, { expanded: [...current.expanded, record.id] })
    host.current?.scrollIntoView({ block: 'nearest' })
  }, [session?.generation, session?.status?.agent, record.id, scopeKey])
  const toggle = () => {
    const ui = useSimpleUi.getState()
    const list = ui.worktrees[scopeKey]?.expanded ?? []
    ui.patch(scopeKey, {
      expanded: expanded ? list.filter((id) => id !== record.id) : [...list, record.id],
    })
  }
  return (
    <article className="simple-agent" ref={host} data-session={record.id}>
      <header>
        <button aria-expanded={expanded} onClick={toggle}>
          {expanded ? '▾' : '▸'} {record.metadata.name}
        </button>
        {record.metadata.componentId === PLAN_SCOPE && <span>Shared planner</span>}
        <StatusLabel status={terminalStatus('agent', session)} />
        <button onClick={() => openTerminal(record)}>Open terminal</button>
      </header>
      {expanded && visible && (
        <div className="simple-terminal">
          <TerminalPane
            componentId={record.metadata.componentId}
            terminal={{
              id: record.metadata.terminalId,
              name: record.metadata.name,
              kind: 'agent',
              command: record.spec.command,
            }}
            task={record.metadata.task ?? null}
            existingSessionId={record.id}
            focus={false}
          />
        </div>
      )}
    </article>
  )
}
