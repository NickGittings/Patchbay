import type { SessionRecord, SessionState } from '../types'
import type { SimpleState } from './simple'

/** Selection never follows a workflow stage or another agent's input wait. */
export function chatRecipient(records: readonly SessionRecord[], selected?: string) {
  return records.find((r) => r.id === selected && r.metadata.kind === 'agent')
}

export function chatAutoActive(status: string | undefined) {
  return status === 'running' || status === 'waitingOnYou'
}

export function chatBusy(session: SessionState | undefined) {
  return (
    !!session?.running &&
    (!session.status?.agent?.authoritative ||
      session.status.agent.state === 'working' ||
      session.status.agent.state === 'needsInput')
  )
}

/** Bounded, editable context; provider transcripts are never silently copied. */
export function chatHandoff(simple: SimpleState | null, branch: string, files: readonly string[]) {
  const messages = (simple?.log ?? [])
    .filter((e) => e.kind === 'prompt' || e.kind === 'reply')
    .slice(-12)
    .map((e) => `${e.kind === 'prompt' ? 'User' : 'Agent'}: ${'text' in e ? e.text : ''}`)
    .join('\n\n')
    .slice(-16000)
  return `Continue work in this workspace.\nBranch: ${branch}\nChanged files: ${files.join(', ') || 'None'}\n\nConversation context:\n${messages || 'Describe the coding task here.'}`
}

export interface ChatInputRequest {
  sessionId: string
  generation: number
  sinceMs: number
}

/** Keep the input host while typing invalidates status, until a hook confirms it closed. */
export function chatInputRequests(
  records: readonly SessionRecord[],
  sessions: Record<string, SessionState>,
  previous: readonly ChatInputRequest[] = [],
): ChatInputRequest[] {
  return records.flatMap((record) => {
    const session = sessions[record.id]
    if (!session?.running || session.disconnected || session.generation === undefined) return []
    const report = session.status?.agent
    const old = previous.find(
      (r) => r.sessionId === record.id && r.generation === session.generation,
    )
    if (old && !report?.authoritative) return [old]
    return report?.state === 'needsInput'
      ? [{ sessionId: record.id, generation: session.generation, sinceMs: report.sinceMs }]
      : []
  })
}
