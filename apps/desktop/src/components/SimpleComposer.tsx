import type { ChatFailureKind } from '../lib/chatTeams'
import { useChatIdentity } from '../lib/chatIdentity'
import { chatRecipient, chatAutoActive } from '../lib/chat'
import { profileHookProvider } from '../lib/agentProfiles'
import { useClockNow } from '../lib/clock'
import {
  exhaustedWindows,
  providerName,
  resetLabel,
  resetsIn,
  useUsage,
  windowName,
} from '../lib/usage'
import { chatPreset, startChatAgent } from '../lib/chatAgent'
import {
  continueChat,
  leadDeliveryPending,
  refreshChatTeams,
  teamFor,
  useChatTeams,
} from '../lib/chatTeams'
import { selectPanel, useRail } from '../lib/rail'
import { persistReplies } from '../lib/simpleReplies'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import type { SessionRecord } from '../types'
import { type SimpleStage } from '../lib/simple'
import { useSimpleUi, EMPTY_SIMPLE_UI } from '../lib/simpleUi'
import {
  composerStatus,
  resumeRecipient,
  sendToSession,
  lastSubmission,
  editedMentions,
  forceable,
  promptReady,
  transmittedText,
  waitForPrompt,
} from '../lib/simpleComposer'
import { logLaunch, logSimple } from '../lib/simpleActions'
import { cancelQueued, enqueuePrompt, flushQueued } from '../lib/simpleQueue'
import { refreshSession, reconcileFreshSessions, stopTerminal } from '../lib/sessions'
import { openIntegrations, useAgentHooksInstalled } from '../lib/agentHooks'

export default function SimpleComposer({
  scopeKey,
  stage,
  records,
  terminalRecord,
  openTerminal,
}: {
  scopeKey: string
  stage: SimpleStage
  records: SessionRecord[]
  terminalRecord?: SessionRecord
  openTerminal: (r: SessionRecord) => void
}) {
  const s = useStore(
    useShallow((s) => ({
      project: s.project,
      activeTask: s.activeTask,
      nodes: s.nodes,
      devices: s.devices,
      agentRoles: s.agentRoles,
      chatAgent: s.workspaceSettings.chatAgent,
      selectedAgent: s.simple?.selectedAgent,
      autoStatus: s.auto?.status,
      serviceConnected: s.serviceConnected,
    })),
  )
  const ui = useSimpleUi((s) => s.worktrees[scopeKey] ?? EMPTY_SIMPLE_UI)
  const patch = (change: Parameters<ReturnType<typeof useSimpleUi.getState>['patch']>[1]) =>
    useSimpleUi.getState().patch(scopeKey, change)
  const recipient = useStore((s) => chatRecipient(records, s.simple?.selectedAgent))
  const team = useChatTeams((state) =>
    state.teams[s.project?.id ?? '']?.find((t) => t.task === s.activeTask),
  )
  const state = useStore((s) => (recipient ? s.sessions[recipient.id] : undefined))
  // The drawer renders only its record; one whose session is gone reads as closed.
  const open = ui.terminal !== 'closed' && !!terminalRecord
  const shown = open ? terminalRecord : recipient
  const identity = useChatIdentity(recipient)
  const terminalIdentity = useChatIdentity(shown)
  const pending =
    !!ui.pendingAction || (!!ui.coordinationReset && team?.reset?.clearHistory !== false)
  const [errorResult, setErrorResult] = useState<{
    key: string
    text: string
    kind?: ChatFailureKind
  }>({ key: '', text: '' })
  const error = errorResult.key === scopeKey ? errorResult.text : ''
  const setError = (text: string, kind?: ChatFailureKind) =>
    setErrorResult({ key: scopeKey, text, kind })
  const [caret, setCaret] = useState(0)
  const submitting = useRef(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const lifecycle = useRef(0)
  useEffect(
    () => () => {
      lifecycle.current++
    },
    [],
  )
  const recipientRef = useRef(recipient?.id)
  useEffect(() => {
    recipientRef.current = recipient?.id
  }, [recipient?.id, stage])
  const lastSubmit = recipient ? lastSubmission(recipient.id, state?.generation) : undefined
  // Readiness changes only through status events, so no clock subscription is needed.
  const ready = promptReady(state, lastSubmit)
  const running = !!state?.running
  // The recipient's provider, else that of the planner Send would start; `null` for neither
  // Claude nor Codex, which can never report a ready prompt.
  const provider = recipient
    ? (profileHookProvider(recipient.spec.command) ?? recipient.metadata.adapter ?? null)
    : null
  const usage = useUsage((s) => s.usage)
  const usageNow = useClockNow(exhaustedWindows(usage, provider, 0).map((w) => w.window.resetsAtMs))
  const exhausted = exhaustedWindows(usage, provider, usageNow)
  const hooks = useAgentHooksInstalled(provider ? [provider] : [])
  // Installed hooks, not `authoritative`, which lapses on Esc and is unset until the first hook.
  const installed = provider ? hooks[provider] : undefined
  const deliveryStatus = composerStatus({
    pending,
    connected: s.serviceConnected,
    provider: provider?.startsWith('claude:')
      ? 'claude'
      : (provider as 'claude' | 'codex' | null | undefined),
    installed,
    session: state,
    ready,
  })
  const autoActive = !team && chatAutoActive(s.autoStatus)
  const status =
    !recipient || autoActive
      ? {
          label: autoActive
            ? 'Pause Auto to resume manual coding'
            : team
              ? 'Send to reconnect'
              : s.project && chatPreset(s.project.id, s.activeTask)
                ? 'Ready to start chat'
                : 'Choose an available Chat agent in Settings',
          sendable:
            !autoActive &&
            !pending &&
            !!s.project &&
            s.serviceConnected &&
            (!!team || !!chatPreset(s.project.id, s.activeTask)),
          action: 'none' as const,
          notice: undefined,
        }
      : deliveryStatus
  const drafted = !pending && !!ui.draft.trim()
  const query = ui.mentions.some((m) => caret > m.start && caret <= m.end)
    ? null
    : ui.draft.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/)
  const candidates = query
    ? s.nodes
        .filter((n) => `${n.id} ${n.data.name}`.toLowerCase().includes(query[1].toLowerCase()))
        .slice(0, 8)
    : []
  // The service applies the same provider, turn and approval checks.
  const canForce = !autoActive && running && !ready && s.serviceConnected && forceable(state)
  const asking = running && state?.status?.agent?.state === 'needsInput'
  const send = async (force = false) => {
    if (ui.unconfirmed || submitting.current || !(force ? canForce : status.sendable) || !s.project)
      return
    const projectId = s.project.id,
      task = s.activeTask,
      draft = ui.draft,
      mentions = [...ui.mentions]
    const mountedEpoch = lifecycle.current
    const initialGeneration = state?.generation
    const text = transmittedText(draft, mentions)
    if (!text.trim()) {
      if (mentions.length) {
        logSimple(projectId, task, {
          kind: 'action',
          action: 'scope',
          stage,
          mentions: mentions.map((m) => m.id),
        })
        patch({ draft: '', mentions: [] })
      }
      return
    }
    setError('')
    if (
      recipient &&
      state?.generation !== undefined &&
      (status.action === 'queue' || useSimpleUi.getState().worktrees[scopeKey]?.queued)
    ) {
      try {
        enqueuePrompt(scopeKey, {
          sessionId: recipient.id,
          generation: state.generation,
          text,
          draft,
          mentions,
          stage,
          atMs: Date.now(),
        })
      } catch (error) {
        setError(String(error))
        return
      }
      // Keep the queued message first, including when Send anyway also submits this draft.
      if (force || ready) await flushQueued(scopeKey, force)
      return
    }
    submitting.current = true
    patch({ pendingAction: true })
    setError('')
    let cancelled = false
    const unsubscribe = useStore.subscribe((next, prev) => {
      if (
        next.project?.id !== prev.project?.id ||
        next.activeTask !== prev.activeTask ||
        next.simpleMode !== prev.simpleMode
      )
        cancelled = true
    })
    const check = () => {
      if (
        lifecycle.current !== mountedEpoch ||
        cancelled ||
        useStore.getState().project?.id !== projectId ||
        useStore.getState().activeTask !== task
      )
        throw new Error('The worktree changed. Your draft was kept.')
    }
    try {
      let target = recipient
      let resolvedTeam = team
      if (!resolvedTeam) {
        await refreshChatTeams(projectId).catch((error) => {
          if (s.selectedAgent) throw error
        })
        resolvedTeam = teamFor(projectId, task)
      }
      let continued = false
      if (resolvedTeam) {
        check()
        const result = await continueChat(resolvedTeam)
        continued = true
        target = result.session
        recipientRef.current = target.id
      } else if (target && !useStore.getState().sessions[target.id]?.running) {
        check()
        const requestId = crypto.randomUUID()
        const recipientId = target.id
        await resumeRecipient(recipientId, requestId, async () => {
          // Claim the resumed run before reconciling, so that pass persists its replies and input
          // waits into this chat. Replies that arrived before the claim were left out: persist now.
          // The claim is logged even if the worktree changed meanwhile, then the send stops.
          await logLaunch(
            projectId,
            task,
            { kind: 'action', action: 'resume', stage, sessionId: recipientId },
            requestId,
          )
          const resumed = useStore.getState().sessions[recipientId]
          if (resumed?.generation !== undefined)
            persistReplies(recipientId, resumed.generation, resumed.replies ?? [])
          check()
          await reconcileFreshSessions()
          await refreshSession(recipientId)
        })
      } else if (!target) {
        check()
        target = await startChatAgent(projectId, task)
      }
      check()
      const sid = target!.id
      let generation = useStore.getState().sessions[sid]?.generation
      if (generation === undefined) {
        await refreshSession(sid)
        generation = useStore.getState().sessions[sid]?.generation
      }
      if (generation === undefined)
        throw new Error('The session has no active process. Open its terminal to continue.')
      const captured = { projectId, task, recipient: sid, generation }
      if (running && !continued && generation !== initialGeneration)
        throw new Error('The process changed. Your draft was kept.')
      const stillCurrent = () => {
        check()
        if (
          useStore.getState().simple?.selectedAgent !== sid ||
          (!resolvedTeam && chatAutoActive(useStore.getState().auto?.status)) ||
          (recipientRef.current && recipientRef.current !== sid)
        )
          return undefined
        const current = useStore.getState().sessions[sid]
        return { ...captured, generation: current?.generation ?? -1 }
      }
      // New and resumed processes wait for their startup prompt.
      if (!running || continued)
        await waitForPrompt(captured, {
          current: stillCurrent,
          session: () => useStore.getState().sessions[sid],
          provider: target!.metadata.adapter ?? null,
          allowWorking: true,
        })
      if (
        ((!running || continued) && !promptReady(useStore.getState().sessions[sid])) ||
        leadDeliveryPending(projectId, task, sid, generation)
      ) {
        check()
        enqueuePrompt(scopeKey, {
          sessionId: sid,
          generation,
          text,
          draft,
          mentions,
          stage,
          atMs: Date.now(),
        })
        return
      }
      await sendToSession({
        projectId,
        task,
        sid,
        generation,
        text,
        mentions: mentions.map((m) => m.id),
        stage,
        force,
        current: stillCurrent,
      })
      const latest = useSimpleUi.getState().worktrees[scopeKey]
      if (latest?.draft === draft && JSON.stringify(latest.mentions) === JSON.stringify(mentions))
        patch({ draft: '', mentions: [] })
    } catch (e) {
      const failure = e as { kind?: ChatFailureKind; message?: string }
      setError(failure.message ?? String(e), failure.kind)
    } finally {
      submitting.current = false
      unsubscribe()
      patch({ pendingAction: false })
    }
  }
  const mention = (id: string) => {
    const end = caret,
      start = end - query![1].length - 1,
      token = `@${id}`
    const draft = ui.draft.slice(0, start) + token + ui.draft.slice(end)
    patch({
      draft,
      mentions: [
        ...editedMentions(ui.draft, draft, ui.mentions),
        { id, token, start, end: start + token.length },
      ],
    })
    if (!useStore.getState().highlighted.includes(id)) useStore.getState().toggleHighlight(id)
    setCaret(start + token.length)
    input.current?.focus()
  }
  const queuedSession = useStore((s) => (ui.queued ? s.sessions[ui.queued.sessionId] : undefined))
  return (
    <div className="simple-composer">
      {(recipient || team) && (
        <p className="chat-recipient" role="status">
          {recipient
            ? `Talking to ${identity.label} · Preset: ${identity.preset} · ${status.label}`
            : status.label}
        </p>
      )}
      {exhausted.map(({ provider, key, window }) => (
        <p className="simple-usage-warning" role="status" key={`${provider}:${key}`}>
          {providerName(provider)} {windowName(key)} usage exhausted (
          {Math.round(window.usedPercent)}%). Resets {resetLabel(window.resetsAtMs, usageNow)} · in{' '}
          {resetsIn(window.resetsAtMs, usageNow)}.
        </p>
      ))}
      {ui.queued && (
        <div className="simple-queued" role="status">
          <span>
            {queuedSession?.status?.agent?.state === 'needsInput'
              ? 'Queued — sends once you answer in the terminal and the agent finishes its turn'
              : queuedSession?.status?.agent?.authoritative
                ? 'Queued — sends when the agent finishes its turn'
                : 'Queued — the agent isn’t confirmed working, so this may not send; continue in its terminal or cancel'}
          </span>
          <button
            disabled={pending || !s.serviceConnected || !forceable(queuedSession)}
            title="Types into the agent now, even mid-turn"
            onClick={() => void flushQueued(scopeKey, true)}
          >
            Send now
          </button>
          <button onClick={() => cancelQueued(scopeKey)}>Cancel</button>
        </div>
      )}
      <div className="simple-mentions">
        {ui.mentions.map((m) => (
          <button
            key={`${m.start}:${m.id}`}
            onClick={() => {
              const draft = ui.draft.slice(0, m.start) + ui.draft.slice(m.end)
              patch({ draft, mentions: editedMentions(ui.draft, draft, ui.mentions) })
            }}
          >
            {s.nodes.find((n) => n.id === m.id)?.data.name ?? m.id} ×
          </button>
        ))}
      </div>
      <textarea
        ref={input}
        aria-label="Message agent"
        value={ui.draft}
        placeholder="Message the agent… @component to scope · Shift+Enter for a newline"
        onSelect={(e) => {
          setCaret(e.currentTarget.selectionStart)
        }}
        onChange={(e) => {
          setCaret(e.target.selectionStart)
          patch({
            draft: e.target.value,
            mentions: editedMentions(ui.draft, e.target.value, ui.mentions),
          })
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
            return
          if (candidates.length && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
            e.preventDefault()
            mention(candidates[0].id)
          } else if (!e.shiftKey || e.metaKey || e.ctrlKey) {
            e.preventDefault()
            if (status.sendable) void send()
          }
        }}
      />
      {candidates.length > 0 && (
        <div role="listbox" aria-label="Mention component">
          {candidates.map((n) => (
            <button role="option" aria-selected={false} key={n.id} onClick={() => mention(n.id)}>
              {n.data.name}
            </button>
          ))}
        </div>
      )}
      <div className="simple-composer-controls">
        <span>{ui.connection ?? status.label}</span>
        {recipient && running && !autoActive && (
          <button disabled={pending} onClick={() => stopTerminal(recipient.id)}>
            Stop {identity.role}
          </button>
        )}
        <button
          disabled={!recipient && !open}
          aria-expanded={open}
          onClick={() => {
            const record = open ? shown : recipient
            if (record) openTerminal(record)
          }}
        >
          {open ? 'Hide' : 'View'} {terminalIdentity.role} terminal
        </button>
        <button
          aria-label="Chat agent settings"
          title="Chat agent settings"
          onClick={() => useRail.setState({ settings: 'roles' })}
        >
          ⚙
        </button>
        {asking
          ? recipient &&
            !(open && shown?.id === recipient.id) && (
              <button onClick={() => openTerminal(recipient)}>Answer in terminal</button>
            )
          : running &&
            !ready && (
              <button
                disabled={pending || !canForce || !ui.draft.trim()}
                title={
                  canForce
                    ? 'Types into the agent now, even mid-turn'
                    : 'Only Codex with a confirmed working turn and no pending approval can be messaged mid-turn'
                }
                onClick={() => void send(true)}
              >
                Send anyway
              </button>
            )}
        <button
          className="primary"
          disabled={!!ui.unconfirmed || !status.sendable || !ui.draft.trim()}
          onClick={() => void send()}
        >
          {status.action === 'queue' ? 'Queue' : 'Send'}
        </button>
      </div>
      {drafted && provider && (status.notice === 'missing' || status.notice === 'failed') && (
        <p className="simple-hook-notice">
          {status.notice === 'missing'
            ? 'Chat can message an agent only with Agent status integration.'
            : 'Agent status integration couldn’t be checked; Chat can message an agent only once its hooks report.'}{' '}
          <button onClick={() => openIntegrations(provider)}>Set up…</button>
        </p>
      )}
      {drafted && status.notice === 'unsupported' && (
        <p className="simple-hook-notice">
          This agent does not report a ready prompt. Continue in its terminal.
        </p>
      )}
      {ui.unconfirmed && (
        <p role="alert">
          Message delivery was not confirmed. Inspect the terminal before retrying.{' '}
          <button
            onClick={() => {
              const record = records.find((r) => r.id === ui.unconfirmed?.sessionId)
              if (record) openTerminal(record)
            }}
          >
            Inspect terminal
          </button>
          <button
            onClick={() => {
              const message = ui.unconfirmed!
              logSimple(s.project!.id, s.activeTask, {
                kind: 'prompt',
                sessionId: message.sessionId,
                generation: message.generation,
                text: message.text,
                stage: message.stage,
                mentions: message.mentions,
                atMs: message.atMs,
              })
              const matches = transmittedText(ui.draft, ui.mentions) === message.text
              patch({ unconfirmed: undefined, ...(matches ? { draft: '', mentions: [] } : {}) })
            }}
          >
            Mark sent
          </button>
          <button onClick={() => patch({ unconfirmed: undefined })}>Retry delivery</button>
        </p>
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          {errorResult.kind === 'access' ? (
            <button onClick={() => selectPanel('project')}>Folder access</button>
          ) : (
            errorResult.kind !== 'authentication' && (
              <button onClick={() => useRail.setState({ settings: 'roles' })}>
                Agent settings
              </button>
            )
          )}
          <button disabled={!!ui.unconfirmed} onClick={() => void send()}>
            {errorResult.kind === 'authentication' ? 'Sign in and retry' : 'Retry connection'}
          </button>
        </p>
      )}
    </div>
  )
}
