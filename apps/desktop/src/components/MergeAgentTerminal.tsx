import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { terminalStatus } from '../lib/display'
import { terminalStop } from '../lib/ipc'
import { mergeRecords } from '../lib/merge'
import { useStore } from '../store'
import type { SessionRecord, TerminalSpec } from '../types'
import TerminalPane from './TerminalPane'
import StatusLabel from './status/StatusLabel'

export default function MergeAgentTerminal({
  selected,
  select,
  hide,
}: {
  selected: SessionRecord
  select: (sid: string) => void
  hide: () => void
}) {
  const records = useStore(
    useShallow((s) => mergeRecords(s.sessionRecords, selected.metadata.projectId)),
  )
  const session = useStore((s) => s.sessions[selected.id])
  const [stopping, setStopping] = useState(false)
  const terminal: TerminalSpec = {
    id: selected.metadata.terminalId,
    name: selected.metadata.name,
    kind: 'agent',
    command: selected.spec.command,
  }
  return (
    <section
      className="review-merge-terminal"
      aria-label="Merge agent terminal"
      data-session={selected.id}
    >
      <header className="terminal-tile-header">
        <strong>Merge agent</strong>
        <select
          aria-label="Merge session"
          value={selected.id}
          onChange={(e) => select(e.target.value)}
        >
          {records.map((r) => (
            <option key={r.id} value={r.id}>
              {r.metadata.name}
            </option>
          ))}
        </select>
        <StatusLabel status={terminalStatus('agent', session)} />
        <span className="spacer" />
        {session?.running && (
          <button
            disabled={stopping}
            onClick={() => {
              setStopping(true)
              void terminalStop(selected.id)
                .catch((e) => useStore.getState().setMessage(String(e)))
                .finally(() => setStopping(false))
            }}
          >
            {stopping ? 'Stopping…' : '■ Stop'}
          </button>
        )}
        <button onClick={hide} title="Hide terminal; the merge agent keeps running">
          Hide
        </button>
      </header>
      <div className="review-merge-location" title={selected.spec.cwd}>
        {selected.spec.cwd}
      </div>
      <TerminalPane
        componentId={selected.metadata.componentId}
        terminal={terminal}
        existingSessionId={selected.id}
        task={null}
      />
    </section>
  )
}
