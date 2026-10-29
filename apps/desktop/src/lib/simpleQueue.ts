import { useStore } from '../store'
import {
  forceable,
  followDeliveries,
  isSending,
  lastSubmission,
  promptReady,
  sendToSession,
} from './simpleComposer'
import { appendDraft, EMPTY_SIMPLE_UI, useSimpleUi, type QueuedPrompt } from './simpleUi'

function restore(key: string, queued: QueuedPrompt, error?: string) {
  const ui = useSimpleUi.getState().worktrees[key] ?? EMPTY_SIMPLE_UI
  useSimpleUi.getState().patch(key, appendDraft(ui, queued))
  if (error) useStore.getState().setMessage(error)
}

/** Append a draft after any earlier message before either normal or forced delivery. */
export function enqueuePrompt(key: string, incoming: QueuedPrompt) {
  const queued = useSimpleUi.getState().worktrees[key]?.queued
  if (
    queued &&
    (queued.sessionId !== incoming.sessionId || queued.generation !== incoming.generation)
  )
    throw new Error('Cancel the queued message for the earlier agent before queueing another.')
  useSimpleUi.getState().patch(key, {
    queued: {
      ...incoming,
      text: [queued?.text, incoming.text].filter(Boolean).join('\n\n'),
      ...appendDraft(queued ?? { draft: '', mentions: [] }, incoming),
    },
    draft: '',
    mentions: [],
  })
}

export function cancelQueued(key: string) {
  const queued = useSimpleUi.getState().worktrees[key]?.queued
  if (!queued) return
  useSimpleUi.getState().patch(key, { queued: undefined })
  restore(key, queued)
}

/** Remove before attempting delivery: a failed or uncertain write is never retried. */
export async function flushQueued(key: string, force = false) {
  const queued = useSimpleUi.getState().worktrees[key]?.queued
  if (!queued) return
  const state = useStore.getState()
  const session = state.sessions[queued.sessionId]
  // Reconciliation can temporarily omit a session. Keep its place until it is known again.
  // A concurrent send also owns the draft until it settles; leave the queue untouched.
  if (!session || isSending(queued.sessionId)) return
  if (!session.running || session.generation !== queued.generation) {
    useSimpleUi.getState().patch(key, { queued: undefined })
    restore(
      key,
      queued,
      session.generation !== queued.generation
        ? 'The agent restarted; your queued message was kept as a draft'
        : 'The agent exited; your queued message was kept as a draft',
    )
    return
  }
  if (!state.serviceConnected || session.disconnected || session.interrupted) return
  if (
    !promptReady(session, lastSubmission(queued.sessionId, queued.generation)) &&
    !(force && forceable(session))
  )
    return
  useSimpleUi.getState().patch(key, { queued: undefined })
  const [projectId, task] = JSON.parse(key) as [string, string | null]
  try {
    await sendToSession({
      projectId,
      task,
      sid: queued.sessionId,
      ...queued,
      mentions: [...new Set(queued.mentions.map((m) => m.id))],
      force,
    })
  } catch (error) {
    restore(key, queued, String(error))
  }
}

export function followQueuedPrompts() {
  const follow = () => {
    for (const [key, ui] of Object.entries(useSimpleUi.getState().worktrees))
      if (ui.queued) void flushQueued(key)
  }
  const stopSessions = useStore.subscribe((state, previous) => {
    if (
      state.sessions !== previous.sessions ||
      state.serviceConnected !== previous.serviceConnected
    )
      follow()
  })
  const stopQueues = useSimpleUi.subscribe((state, previous) => {
    if (
      Object.entries(state.worktrees).some(
        ([key, ui]) => ui.queued && ui.queued !== previous.worktrees[key]?.queued,
      )
    )
      follow()
  })
  const stopDeliveries = followDeliveries(follow)
  follow()
  return () => {
    stopSessions()
    stopQueues()
    stopDeliveries()
  }
}
