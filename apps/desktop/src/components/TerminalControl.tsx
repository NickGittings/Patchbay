import { useRef, useState } from 'react'
import { useStore } from '../store'
import { autoControlsAgent, newConversation, startTerminal, stopTerminal } from '../lib/sessions'
import {
  isReservedScope,
  isReviewAgentScope,
  PLAN_SCOPE,
  TASK_ROOT_SCOPE,
  type SessionState,
  type TerminalSpec,
} from '../types'

/** Header actions stay available even when the pane cannot load its saved output. */
export default function TerminalControl({
  kind,
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
  kind: TerminalSpec['kind']
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
  const connected = useStore((s) => s.serviceConnected)
  const ownerProject = projectId ?? useStore.getState().project?.id ?? ''
  const auto = useStore(() => autoControlsAgent(ownerProject, sid))
  const [freshPending, setFreshPending] = useState(false)
  const pending = useRef(false)
  const interactive =
    kind === 'agent' &&
    (!isReservedScope(componentId) || componentId === PLAN_SCOPE || componentId === TASK_ROOT_SCOPE)
  const busy = restarting || freshPending
  const fresh = async () => {
    if (pending.current || busy || disabled || auto || !connected) return
    if (
      !window.confirm(
        'Start a new conversation with the current Patchbay briefing? This stops the current agent. Saved history remains available.',
      )
    )
      return
    pending.current = true
    setFreshPending(true)
    try {
      await newConversation(componentId, terminalId, task, projectId)
    } catch (e) {
      useStore.getState().setMessage(String(e))
    } finally {
      pending.current = false
      setFreshPending(false)
    }
  }
  return (
    <>
      {kind === 'agent' && <ContextIndicator session={session} connected={connected} />}
      {interactive && (
        <button
          disabled={disabled || busy || auto || !connected}
          title={auto ? 'Stop Auto before starting a new conversation' : undefined}
          onClick={() => void fresh()}
        >
          {freshPending ? 'Starting…' : 'New conversation'}
        </button>
      )}
      {session?.running ? (
        <button disabled={disabled || busy} onClick={() => stopTerminal(sid)}>
          ■ Stop
        </button>
      ) : !isReviewAgentScope(componentId) ? (
        <button
          disabled={disabled || busy}
          onClick={() => void startTerminal(componentId, terminalId, task, projectId)}
        >
          ▶ {busy ? 'Stopping…' : session ? 'Restart' : 'Start'}
        </button>
      ) : null}
      {session?.running && onRestart && (
        <button disabled={disabled || busy} onClick={() => void onRestart()}>
          {busy ? 'Stopping…' : '↻ Restart'}
        </button>
      )}
    </>
  )
}

/** Missing observations stay explicit; disconnected and ended data is historical. */
function ContextIndicator({ session, connected }: { session?: SessionState; connected: boolean }) {
  const context = session?.status?.context
  const historical = !connected || !session?.running || session.status?.agent?.state === 'ended'
  const count = (value: number | null | undefined) =>
    value == null ? 'unavailable' : value.toLocaleString()
  const title = `Used tokens: ${count(context?.usedTokens)}; context window: ${count(context?.windowTokens)}; observed: ${context?.observedMs == null ? 'unavailable' : new Date(context.observedMs).toLocaleString()}${historical ? ' (historical)' : ''}`
  return (
    <span className="agent-context hint" title={title} role="status">
      {context?.usedPercent == null
        ? 'Context unavailable'
        : `Context ${Math.round(context.usedPercent)}%`}
      {historical &&
        (context?.observedMs != null || context?.lastCompactionMs != null) &&
        ' (historical)'}
      {context?.compaction === 'compacting' &&
        (historical ? ' · Compaction (historical)' : ' · Compacting…')}
      {context?.compaction !== 'compacting' &&
        context?.lastCompactionMs != null &&
        ` · Last compacted ${new Date(context.lastCompactionMs).toLocaleTimeString()}`}
    </span>
  )
}
