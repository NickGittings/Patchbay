import { useStore } from '../store'
import type { SessionState } from '../types'
import { leadDeliveryPending, teamFor, useChatTeams } from './chatTeams'
import { chatAutoActive, limitStopped } from './chat'
import {
  componentMentions,
  forceable,
  forcedSettleAt,
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
  if (error) useStore.getState().setMessage(error, undefined, undefined, 'error')
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

// A forced message steered into its turn leaves no later hook to follow: look again once
// that stopped turn has settled.
const settling = new Map<string, ReturnType<typeof setTimeout>>()
function clearSettling(key?: string) {
  for (const [k, timer] of settling)
    if (key === undefined || k === key) {
      clearTimeout(timer)
      settling.delete(k)
    }
}

/** Whether Send now can deliver: into a working Codex turn, or to a limit-stopped agent's prompt. */
export function sendableNow(queued: QueuedPrompt, session: SessionState | undefined) {
  return (
    forceable(session) ||
    (limitStopped(session) &&
      promptReady(session, lastSubmission(queued.sessionId, queued.generation)))
  )
}

/** Remove before attempting delivery: a failed or uncertain write is never retried. */
export async function flushQueued(key: string, force = false) {
  clearSettling(key)
  const queued = useSimpleUi.getState().worktrees[key]?.queued
  if (!queued) return
  const state = useStore.getState()
  const [projectId, task] = JSON.parse(key) as [string, string | null]
  // Background queues retain their original workspace and wait while Auto owns it.
  const autoActive = () => {
    const latest = useStore.getState()
    const project = latest.project?.id === projectId ? latest : latest.projects?.[projectId]?.state
    const workspace = project?.activeTask === task ? project : project?.taskWorkspaces?.[task ?? '']
    return !teamFor(projectId, task) && chatAutoActive(workspace?.auto?.status)
  }
  if (
    autoActive() ||
    useSimpleUi.getState().worktrees[key]?.coordinationReset ||
    useSimpleUi.getState().worktrees[key]?.pendingAction ||
    useSimpleUi.getState().worktrees[key]?.unconfirmed ||
    leadDeliveryPending(projectId, task, queued.sessionId, queued.generation)
  )
    return
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
  // Held for Send or Send now, or returned as a draft once the agent is replaced.
  if (!force && limitStopped(session)) return
  const submission = lastSubmission(queued.sessionId, queued.generation)
  if (!promptReady(session, submission) && !(force && forceable(session))) {
    const settleAt = forcedSettleAt(session, submission)
    if (settleAt !== undefined)
      settling.set(
        key,
        setTimeout(() => void flushQueued(key), Math.max(0, settleAt - Date.now())),
      )
    return
  }
  useSimpleUi.getState().patch(key, { queued: undefined })
  useSimpleUi.getState().patch(key, { pendingAction: true })
  try {
    await sendToSession({
      projectId,
      task,
      sid: queued.sessionId,
      ...queued,
      mentions: [...new Set(componentMentions(queued.mentions))],
      force,
      current: () => {
        if (autoActive() || useSimpleUi.getState().worktrees[key]?.coordinationReset)
          throw new Error(
            'Auto took control of this workspace. Your queued message was kept as a draft.',
          )
        return {
          projectId,
          task,
          recipient: queued.sessionId,
          generation: useStore.getState().sessions[queued.sessionId]?.generation ?? -1,
        }
      },
    })
  } catch (error) {
    restore(key, queued, String(error))
  } finally {
    useSimpleUi.getState().patch(key, { pendingAction: false })
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
      state.serviceConnected !== previous.serviceConnected ||
      state.auto !== previous.auto ||
      state.taskWorkspaces !== previous.taskWorkspaces ||
      state.projects !== previous.projects
    )
      follow()
  })
  const stopQueues = useSimpleUi.subscribe((state, previous) => {
    if (
      Object.entries(state.worktrees).some(
        ([key, ui]) =>
          ui.queued &&
          (ui.queued !== previous.worktrees[key]?.queued ||
            (previous.worktrees[key]?.pendingAction && !ui.pendingAction)),
      )
    )
      follow()
  })
  const stopTeams = useChatTeams.subscribe(follow)
  const stopDeliveries = followDeliveries(follow)
  follow()
  return () => {
    clearSettling()
    stopSessions()
    stopQueues()
    stopDeliveries()
    stopTeams()
  }
}
