import { activityFile, activityRoot } from '../lib/activity'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { PLAN_SCOPE, type SessionRecord } from '../types'
import type { TerminalStatus } from '../lib/display'
import { useSimpleUi, EMPTY_SIMPLE_UI } from '../lib/simpleUi'
import SimpleStatus from './SimpleStatus'
import TerminalPane from './TerminalPane'

const attention = new Map<string, string>()
export default function SimpleAgent({
  record,
  status,
  scopeKey,
  openTerminal,
}: {
  record: SessionRecord
  status: TerminalStatus
  scopeKey: string
  openTerminal: (r: SessionRecord) => void
}) {
  const project = useStore((s) => s.project)
  const tasks = useStore((s) => s.tasks)
  const nodes = useStore((s) => s.nodes)
  const session = useStore((s) => s.sessions[record.id])
  const manuallyExpanded = useSimpleUi((s) =>
    (s.worktrees[scopeKey] ?? EMPTY_SIMPLE_UI).expanded.includes(record.id),
  )
  const host = useRef<HTMLElement>(null)
  const terminalHost = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const needsInput = status.health === 'input'
  const expanded = manuallyExpanded || needsInput
  useEffect(() => {
    const el = terminalHost.current
    if (!el || !expanded) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    observer.observe(el)
    return () => observer.disconnect()
  }, [expanded])
  useEffect(() => {
    const agent = session?.status?.agent
    if (!needsInput || !agent) return
    const key = `${session?.generation}:${agent.sinceMs}`
    if (attention.get(record.id) === key) return
    attention.set(record.id, key)
    host.current?.scrollIntoView({ block: 'nearest' })
  }, [needsInput, session?.generation, session?.status?.agent, record.id, scopeKey])
  const toggle = () => {
    if (needsInput) return
    const ui = useSimpleUi.getState()
    const list = ui.worktrees[scopeKey]?.expanded ?? []
    ui.patch(scopeKey, {
      expanded: list.includes(record.id)
        ? list.filter((id) => id !== record.id)
        : [...list, record.id],
    })
  }
  return (
    <article
      className="simple-agent"
      ref={host}
      data-session={record.id}
      data-needs-input={needsInput || undefined}
    >
      <header>
        <button aria-expanded={expanded} aria-disabled={needsInput || undefined} onClick={toggle}>
          {expanded ? '▾' : '▸'} {record.metadata.name}
        </button>
        {record.metadata.componentId === PLAN_SCOPE && <span>Shared planner</span>}
        <SimpleStatus sessions={[session]} />
        <button onClick={() => openTerminal(record)}>Open terminal</button>
      </header>
      {!!session?.activity?.length && (
        <ol className="simple-activity">
          {session.activity.slice(-6).map((activity) => {
            const worktree = activityRoot(record, tasks, project?.root ?? record.spec.cwd)
            const file = activityFile(
              activity,
              record,
              nodes.map((n) => ({ id: n.id, path: n.data.path })),
              worktree,
            )
            return (
              <li key={activity.sequence}>
                <span>{activity.tool}</span>
                {file ? (
                  <button onClick={() => useSimpleUi.getState().patch(scopeKey, { diff: file })}>
                    {activity.target}
                  </button>
                ) : (
                  <span>{activity.target}</span>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {expanded && (
        <div className="simple-terminal" ref={terminalHost}>
          {visible && (
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
          )}
        </div>
      )}
    </article>
  )
}
