import type { SessionState } from '../types'
import { chatBusy } from './chat'
import { interruptible, lastSubmission, promptReady } from './simpleComposer'
import type { SimpleUi } from './simpleUi'

/** The first thing Chat must settle before it can prepare a new Auto run. */
export function chatAutoHandoff(
  ui: Pick<
    SimpleUi,
    | 'pendingAction'
    | 'pendingWorkflow'
    | 'queued'
    | 'connection'
    | 'coordinationReset'
    | 'unconfirmed'
  >,
  agent: { id: string; name: string; session?: SessionState } | undefined,
  connected: boolean,
) {
  if (ui.connection) return { message: ui.connection }
  if (ui.coordinationReset) return { message: 'Wait for the lead replacement to settle.' }
  if (ui.pendingAction) return { message: 'Wait for the Chat message or agent request to finish.' }
  if (ui.pendingWorkflow) return { message: 'Wait for the current work command to finish.' }
  if (ui.unconfirmed)
    return {
      message: 'Check the unconfirmed message in the composer before handing off to Auto.',
      composer: true,
    }
  if (ui.queued)
    return {
      message: 'Cancel the queued message to return it to your draft, or wait for its delivery.',
      queued: true,
    }
  const session = agent?.session
  if (!agent || !session?.running) return undefined
  if (!connected || session.disconnected)
    return { message: `Wait for the session service to reconnect to ${agent.name}.` }
  if (session.chatStartup === 'pending')
    return { message: `Wait for ${agent.name} to finish starting.` }
  if (!chatBusy(session)) return undefined
  const ready = promptReady(session, lastSubmission(agent.id, session.generation))
  const status = session.status?.agent
  if (status?.state === 'needsInput' || status?.approvalPending)
    return {
      message: `${agent.name} needs input before Chat can hand off to Auto.`,
      terminal: true,
    }
  return {
    message: `Wait for ${agent.name}’s turn to finish before handing off to Auto.`,
    interrupt:
      session.generation !== undefined && interruptible(session, ready)
        ? {
            id: agent.id,
            generation: session.generation,
            turn: status?.turnId,
            since: status?.sinceMs,
          }
        : undefined,
  }
}
