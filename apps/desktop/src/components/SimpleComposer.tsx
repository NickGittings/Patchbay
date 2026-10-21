import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { PLAN_SCOPE, plannerSessionId } from '../types'
import type { SessionRecord } from '../types'
import { selectRecipient, type SimpleStage } from '../lib/simple'
import { useSimpleUi, EMPTY_SIMPLE_UI } from '../lib/simpleUi'
import { deliverPrompt, editedMentions, promptReady, transmittedText } from '../lib/simpleComposer'
import { logSimple } from '../lib/simpleActions'
import { roleDevice } from '../lib/agentRoles'
import { sessionResume, terminalAttach, terminalDetach, terminalWrite } from '../lib/ipc'
import { refreshSession, reconcileFreshSessions, startTerminal } from '../lib/sessions'
import { hasVisibleTerminal } from '../lib/terminals'

const submitted = new Map<string, { generation: number; atMs: number }>()
export default function SimpleComposer({
  scopeKey,
  stage,
  records,
  openTerminal,
}: {
  scopeKey: string
  stage: SimpleStage
  records: SessionRecord[]
  openTerminal: (r: SessionRecord) => void
}) {
  const s = useStore()
  const ui = useSimpleUi((s) => s.worktrees[scopeKey] ?? EMPTY_SIMPLE_UI)
  const patch = (change: Parameters<ReturnType<typeof useSimpleUi.getState>['patch']>[1]) =>
    useSimpleUi.getState().patch(scopeKey, change)
  const recipient = selectRecipient(records, s.sessions, stage, ui.recipient)
  const [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [now, setNow] = useState(() => Date.now())
  const [caret, setCaret] = useState(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const recipientRef = useRef(recipient?.id)
  useEffect(() => {
    recipientRef.current = recipient?.id
  }, [recipient?.id])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])
  const state = recipient ? s.sessions[recipient.id] : undefined
  const last = recipient ? submitted.get(recipient.id) : undefined
  const lastSubmit = last?.generation === state?.generation ? last?.atMs : undefined
  const ready = promptReady(state, now, lastSubmit)
  const running = !!state?.running
  const query = ui.draft.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/)
  const candidates = query
    ? s.nodes
        .filter((n) => `${n.id} ${n.data.name}`.toLowerCase().includes(query[1].toLowerCase()))
        .slice(0, 8)
    : []
  const send = async () => {
    if (pending || !s.project) return
    const projectId = s.project.id,
      task = s.activeTask,
      draft = ui.draft,
      mentions = [...ui.mentions]
    const requestedOverride = ui.recipient
    const initialGeneration = state?.generation
    const text = transmittedText(draft, mentions)
    if (!text.trim()) {
      if (mentions.length) patch({ draft: '', mentions: [] })
      return
    }
    setPending(true)
    setError('')
    let cancelled = false
    const unsubscribe = useStore.subscribe((next, prev) => {
      if (next.project?.id !== prev.project?.id || next.activeTask !== prev.activeTask)
        cancelled = true
    })
    const check = () => {
      if (
        cancelled ||
        useStore.getState().project?.id !== projectId ||
        useStore.getState().activeTask !== task
      )
        throw new Error('The worktree changed. Your draft was kept.')
    }
    try {
      let target = recipient
      if (target && !useStore.getState().sessions[target.id]?.running) {
        check()
        await sessionResume(target.id)
        logSimple(projectId, task, {
          kind: 'action',
          action: 'resume',
          stage,
          sessionId: target.id,
        })
        await reconcileFreshSessions()
        await refreshSession(target.id)
      } else if (!target) {
        if (stage !== 'plan')
          throw new Error('Open a stage terminal or choose another recipient to continue.')
        const device = roleDevice(s.devices, s.agentRoles, 'plan')
        await startTerminal(PLAN_SCOPE, device.id, null, projectId)
        await reconcileFreshSessions()
        target = useStore
          .getState()
          .sessionRecords.find((r) => r.id === plannerSessionId(device.id, projectId))
        if (!target) throw new Error('The planner did not start. Open its terminal to continue.')
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
      const targetOverride = requestedOverride
      if (running && generation !== initialGeneration)
        throw new Error('The process changed. Your draft was kept.')
      const stillCurrent = () => {
        check()
        if (
          useSimpleUi.getState().worktrees[scopeKey]?.recipient !== targetOverride ||
          (recipient && recipientRef.current !== recipient.id)
        )
          return undefined
        const current = useStore.getState().sessions[sid]
        return { ...captured, generation: current?.generation ?? -1 }
      }
      const began = Date.now()
      // Only a new/resumed process waits for startup; busy running recipients are never queued.
      if (!running) {
        while (!promptReady(useStore.getState().sessions[sid], Date.now())) {
          if (
            stillCurrent()?.generation !== generation ||
            !useStore.getState().sessions[sid]?.running
          )
            throw new Error('The session changed. Your draft was kept.')
          if (useStore.getState().sessions[sid]?.status?.agent?.state === 'needsInput')
            throw new Error('The agent needs input in its terminal.')
          if (Date.now() - began >= 30000)
            throw new Error('No ready prompt after 30 seconds. Open the terminal to continue.')
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      const stamp = submitted.get(sid)
      const previous = stamp?.generation === generation ? stamp.atMs : undefined
      await deliverPrompt(
        captured,
        text,
        {
          current: stillCurrent,
          session: () => useStore.getState().sessions[sid],
          claim: () => terminalAttach(sid, true),
          write: (bytes) => terminalWrite(sid, bytes),
          release: async () => {
            if (!hasVisibleTerminal(sid)) await terminalDetach(sid)
          },
        },
        previous,
      )
      submitted.set(sid, { generation, atMs: Date.now() })
      logSimple(projectId, task, {
        kind: 'prompt',
        stage,
        sessionId: sid,
        generation,
        text,
        mentions: mentions.map((m) => m.id),
      })
      const latest = useSimpleUi.getState().worktrees[scopeKey]
      if (latest?.draft === draft) patch({ draft: '', mentions: [] })
    } catch (e) {
      setError(String(e))
    } finally {
      unsubscribe()
      setPending(false)
    }
  }
  return (
    <div className="simple-composer">
      <label>
        To{' '}
        <select
          aria-label="Message recipient"
          value={recipient?.id ?? ''}
          onChange={(e) => patch({ recipient: e.target.value || undefined })}
        >
          <option value="">Current stage · {stage}</option>
          {records.map((r) => (
            <option key={r.id} value={r.id}>
              {r.metadata.name}
              {r.metadata.componentId === PLAN_SCOPE ? ' · shared planner' : ''}
            </option>
          ))}
        </select>
      </label>
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
        placeholder="Message the agent… @component to scope future launches"
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
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            if (!running || ready) void send()
          }
        }}
      />
      {candidates.length > 0 && (
        <div role="listbox" aria-label="Mention component">
          {candidates.map((n) => (
            <button
              role="option"
              aria-selected={false}
              key={n.id}
              onClick={() => {
                const end = caret,
                  start = end - query![1].length - 1,
                  token = `@${n.id}`
                const draft = ui.draft.slice(0, start) + token + ui.draft.slice(end)
                patch({
                  draft,
                  mentions: [
                    ...editedMentions(ui.draft, draft, ui.mentions),
                    { id: n.id, token, start, end: start + token.length },
                  ],
                })
                if (!useStore.getState().highlighted.includes(n.id))
                  useStore.getState().toggleHighlight(n.id)
                setCaret(start + token.length)
                input.current?.focus()
              }}
            >
              {n.data.name}
            </button>
          ))}
        </div>
      )}
      <div className="simple-composer-controls">
        <span>
          {pending
            ? 'Waiting for ready prompt…'
            : running
              ? ready
                ? 'Ready'
                : state?.status?.agent?.state === 'needsInput'
                  ? 'Answer in terminal'
                  : 'Agent is working'
              : 'Send to start or resume'}
        </span>
        {recipient && <button onClick={() => openTerminal(recipient)}>Open terminal</button>}
        <button
          className="primary"
          disabled={pending || !ui.draft.trim() || (running && !ready)}
          onClick={() => void send()}
        >
          Send
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
