import { startTerminal, stopTerminal } from '../lib/sessions'
import { isReviewAgentScope, type SessionState } from '../types'

/** Header actions stay available even when the pane cannot load its saved output. */
export default function TerminalControl({
  componentId,
  terminalId,
  sid,
  session,
  task,
  projectId,
  disabled = false,
  restarting = false,
  onRestart,
}: {
  componentId: string
  terminalId: string
  sid: string
  session?: SessionState
  task: string | null
  projectId?: string
  disabled?: boolean
  restarting?: boolean
  /** The planner also offers a restart while running to apply changed context. */
  onRestart?: () => Promise<void>
}) {
  return (
    <>
      {session?.running ? (
        <button disabled={disabled || restarting} onClick={() => stopTerminal(sid)}>
          ■ Stop
        </button>
      ) : !isReviewAgentScope(componentId) ? (
        <button
          disabled={disabled || restarting}
          onClick={() => void startTerminal(componentId, terminalId, task, projectId)}
        >
          ▶ {restarting ? 'Stopping…' : session ? 'Restart' : 'Start'}
        </button>
      ) : null}
      {session?.running && onRestart && (
        <button disabled={disabled || restarting} onClick={() => void onRestart()}>
          {restarting ? 'Stopping…' : '↻ Restart'}
        </button>
      )}
    </>
  )
}
