import { useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { projectStateOf, useStore, workspaceOf } from '../store'
import { sessionId, TASK_ROOT_SCOPE, type SessionRecord } from '../types'
import { planTerminals } from '../lib/plan'
import { chatHandoff, chatAutoActive } from '../lib/chat'
import { selectChatAgent } from '../lib/agentChats'
import { logSimple } from '../lib/simpleActions'
import { reconcileFreshSessions, startTerminal } from '../lib/sessions'
import { appendDraft, EMPTY_SIMPLE_UI, simpleKey, useSimpleUi } from '../lib/simpleUi'

export default function ChatAgentPicker({
  records,
  branch,
  files,
}: {
  records: SessionRecord[]
  branch: string
  files: string[]
}) {
  const s = useStore(
    useShallow((s) => ({
      project: s.project,
      activeTask: s.activeTask,
      devices: s.devices,
      simple: s.simple,
      auto: s.auto,
    })),
  )
  const projectId = s.project?.id
  const task = s.activeTask
  const key = simpleKey(projectId, task)
  const presets = planTerminals(s.devices)
  const [handoff, setHandoff] = useState<{ key: string; choice: string; text: string }>()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState('')
  const ui = useSimpleUi((u) => u.worktrees[key] ?? EMPTY_SIMPLE_UI)
  const disabled =
    busy ||
    !!ui.pendingAction ||
    !!ui.pendingWorkflow ||
    !!ui.queued ||
    chatAutoActive(s.auto?.status)
  const choose = async (choice: string, context?: string) => {
    if (!projectId || pending.current || disabled) return
    pending.current = true
    setBusy(true)
    useSimpleUi.getState().patch(key, { pendingAction: true })
    setError('')
    try {
      let sid = choice.slice(8)
      if (choice.startsWith('preset:')) {
        const preset = presets.find((p) => p.id === choice.slice(7))
        if (!preset) throw new Error('This agent preset is no longer available.')
        const terminal = { ...preset, id: `chat-${crypto.randomUUID()}` }
        const current = projectStateOf(projectId)!
        const workspace = workspaceOf(current, task)
        useStore
          .getState()
          .patchTask(projectId, task, { rootTerminals: [...workspace.rootTerminals, terminal] })
        await startTerminal(TASK_ROOT_SCOPE, terminal.id, task, projectId)
        await reconcileFreshSessions()
        sid = sessionId(TASK_ROOT_SCOPE, terminal.id, task, projectId)
        if (!useStore.getState().sessions[sid]?.running)
          throw new Error(
            'The agent did not start. Open Terminals to retry the workspace session, then select it here.',
          )
      }
      if (
        !useStore
          .getState()
          .sessionRecords.some(
            (r) => r.id === sid && records.some((eligible) => eligible.id === sid),
          ) &&
        !choice.startsWith('preset:')
      )
        throw new Error('This session is no longer available in this workspace.')
      selectChatAgent(projectId, task, sid)
      const record = useStore.getState().sessionRecords.find((r) => r.id === sid)
      logSimple(projectId, task, {
        kind: 'action',
        action: 'selectAgent',
        stage: 'build',
        sessionId: sid,
        text: `Talking to ${record?.metadata.name ?? 'agent'}.`,
      })
      if (context?.trim()) {
        const draft = useSimpleUi.getState().worktrees[key] ?? EMPTY_SIMPLE_UI
        useSimpleUi.getState().patch(key, appendDraft({ draft: context, mentions: [] }, draft))
        logSimple(projectId, task, {
          kind: 'action',
          action: 'handoff',
          stage: 'build',
          sessionId: sid,
          text: 'Agent handoff reviewed. Send the prepared message to continue.',
        })
      }
      setHandoff(undefined)
    } catch (e) {
      setError(String(e))
    } finally {
      pending.current = false
      setBusy(false)
      useSimpleUi.getState().patch(key, { pendingAction: false })
    }
  }
  const selected = s.simple?.selectedAgent
  return (
    <div className="chat-agent-picker">
      <label>
        Talking to{' '}
        <select
          aria-label="Chat agent"
          value={selected ? `session:${selected}` : ''}
          disabled={disabled}
          onChange={(e) => {
            const choice = e.target.value
            if (!choice) return
            if (selected || s.simple?.log.some((e) => e.kind === 'prompt'))
              setHandoff({ key, choice, text: chatHandoff(s.simple, branch, files) })
            else void choose(choice)
          }}
        >
          <option value="" disabled>
            Choose an agent…
          </option>
          {selected && !records.some((r) => r.id === selected) && (
            <option value={`session:${selected}`}>Unavailable agent — choose another</option>
          )}
          <optgroup label="Workspace sessions">
            {records
              .filter((r) => r.metadata.kind === 'agent')
              .map((r) => (
                <option value={`session:${r.id}`} key={r.id}>
                  {r.metadata.name} · {r.metadata.adapter ?? 'agent'} · {r.id.slice(-8)}
                </option>
              ))}
          </optgroup>
          <optgroup label="Start a new agent">
            {presets.map((p) => (
              <option key={p.id} value={`preset:${p.id}`}>
                {p.name}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <span>{branch}</span>
      {handoff?.key === key && (
        <div role="group" aria-label="Review agent handoff">
          <p>Review the context for this agent. It will be placed in your composer for sending.</p>
          <textarea
            aria-label="Agent handoff context"
            rows={7}
            value={handoff.text}
            disabled={busy}
            onChange={(e) => setHandoff({ ...handoff, text: e.target.value })}
          />
          <button disabled={disabled} onClick={() => void choose(handoff.choice, handoff.text)}>
            Use agent and prepare message
          </button>
          <button disabled={busy} onClick={() => setHandoff(undefined)}>
            Cancel
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
