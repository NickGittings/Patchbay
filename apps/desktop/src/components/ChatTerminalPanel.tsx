import { useChatIdentity } from '../lib/chatIdentity'
import type { SessionRecord } from '../types'
import TerminalPane from './TerminalPane'

/**
 * Chat's terminal takes the composer's place (or all of Chat, maximized) until closed. Only ×
 * closes it: Escape belongs to the program running in the terminal.
 */
export default function ChatTerminalPanel({
  record,
  maximized,
  toggleMaximized,
  close,
}: {
  record: SessionRecord
  maximized: boolean
  toggleMaximized: () => void
  close: () => void
}) {
  const identity = useChatIdentity(record)
  return (
    <section
      className="simple-terminal-drawer chat-terminal-panel"
      data-maximized={maximized || undefined}
      aria-label={`${identity.role} terminal`}
    >
      <header>
        <span title={identity.title}>{identity.title}</span>
        <button
          aria-pressed={maximized}
          aria-label={maximized ? 'Restore terminal size' : 'Maximize terminal'}
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={toggleMaximized}
        >
          {maximized ? '⤡' : '⤢'}
        </button>
        <button aria-label="Close terminal" title="Close terminal" onClick={close}>
          ×
        </button>
      </header>
      <TerminalPane
        key={record.id}
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
    </section>
  )
}
