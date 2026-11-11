import { useState } from 'react'
import { useStore } from '../store'
import type { SessionRecord } from '../types'
import TerminalPane from './TerminalPane'

/** Native input stays in its originating PTY; never synthesize menu/approval keystrokes. */
export default function ChatQuestion({ record }: { record: SessionRecord }) {
  const session = useStore((s) => s.sessions[record.id])
  const [open, setOpen] = useState(false)
  return (
    <details className="chat-question" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {record.metadata.name} needs your input:{' '}
        {session?.status?.agent?.message ?? 'Open to respond'}
      </summary>
      <p>Respond directly to {record.metadata.name} below.</p>
      {open && (
        <div className="simple-terminal-drawer">
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
    </details>
  )
}
