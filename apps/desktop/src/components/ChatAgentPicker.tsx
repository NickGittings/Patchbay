import { useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { projectStateOf, useStore, workspaceOf } from '../store'
import { sessionId, TASK_ROOT_SCOPE, type SessionRecord } from '../types'
import { planTerminals } from '../lib/plan'
import { chatAutoActive } from '../lib/chat'
import { selectChatAgent } from '../lib/agentChats'
import { logSimple } from '../lib/simpleActions'
import { reconcileFreshSessions, startTerminal } from '../lib/sessions'
import { EMPTY_SIMPLE_UI, simpleKey, useSimpleUi } from '../lib/simpleUi'
import { initializeTeam, resetLead, newLead, teamFor, useChatTeams } from '../lib/chatTeams'

export default function ChatAgentPicker({
  records,
  branch,
}: {
  records: SessionRecord[]
  branch: string
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
  const team = useChatTeams((s) => s.teams[projectId ?? '']?.find((t) => t.task === task))
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState('')
  const ui = useSimpleUi((u) => u.worktrees[key] ?? EMPTY_SIMPLE_UI)
  const disabled =
    busy ||
    !!ui.pendingAction ||
    !!ui.pendingWorkflow ||
    !!team?.reset ||
    chatAutoActive(s.auto?.status)
  const eligible = records.filter(
    (r) =>
      r.metadata.kind === 'agent' &&
      !['@worker', '@coordinator', '@scan', '@review', '@map'].includes(r.metadata.componentId),
  )
  const choose = async (choice: string) => {
    if (!projectId || pending.current || disabled) return
    pending.current = true
    setBusy(true)
    useSimpleUi.getState().patch(key, { pendingAction: true })
    setError('')
    try {
      let sid = choice.slice(8)
      if (choice.startsWith('preset:')) {
        const preset = presets.find((p) => p.id === choice.slice(7))
        if (!preset) throw new Error('This lead preset is no longer available.')
        const terminal = { ...preset, id: `chat-${crypto.randomUUID()}` }
        const current = projectStateOf(projectId)!
        const workspace = workspaceOf(current, task)
        useStore
          .getState()
          .patchTask(projectId, task, { rootTerminals: [...workspace.rootTerminals, terminal] })
        const existing = teamFor(projectId, task)
        if (existing) {
          await newLead(existing, terminal)
          return
        }
        await startTerminal(TASK_ROOT_SCOPE, terminal.id, task, projectId)
        await reconcileFreshSessions()
        sid = sessionId(TASK_ROOT_SCOPE, terminal.id, task, projectId)
        if (!useStore.getState().sessions[sid]?.running)
          throw new Error(
            'The lead did not start. Open Terminals to retry the workspace session, then select it here.',
          )
      } else if (!eligible.some((r) => r.id === sid)) {
        throw new Error('This lead is no longer available in this workspace.')
      }
      const record = useStore.getState().sessionRecords.find((r) => r.id === sid)
      if (!record) throw new Error('The lead session is not available. Refresh sessions and retry.')
      const existing = teamFor(projectId, task)
      if (existing) {
        if (existing.lead.sessionId !== sid) await resetLead(existing, sid)
      } else {
        selectChatAgent(projectId, task, sid)
        try {
          await initializeTeam(projectId, task, record)
        } catch (e) {
          throw new Error(
            `Coordination unavailable: ${String(e)}. Continue locally with this lead.`,
          )
        }
        logSimple(projectId, task, {
          kind: 'action',
          action: 'selectAgent',
          stage: 'build',
          sessionId: sid,
          text: `Lead: ${record.metadata.name}.`,
        })
      }
    } catch (e) {
      setError(String(e))
    } finally {
      pending.current = false
      setBusy(false)
      useSimpleUi.getState().patch(key, { pendingAction: false })
    }
  }
  const selected = team?.lead.sessionId ?? s.simple?.selectedAgent
  return (
    <div className="chat-agent-picker">
      <label>
        Lead{' '}
        <select
          aria-label="Chat lead"
          value={selected ? `session:${selected}` : ''}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value) void choose(e.target.value)
          }}
        >
          <option value="" disabled>
            Choose a lead…
          </option>
          {selected && !eligible.some((r) => r.id === selected) && (
            <option value={`session:${selected}`}>Unavailable lead — choose another</option>
          )}
          <optgroup label="Workspace sessions">
            {eligible.map((r) => (
              <option value={`session:${r.id}`} key={r.id}>
                {r.metadata.name} · {r.metadata.adapter ?? 'agent'} · {r.id.slice(-8)}
              </option>
            ))}
          </optgroup>
          <optgroup label="Start a new lead">
            {presets.map((p) => (
              <option key={p.id} value={`preset:${p.id}`}>
                {p.name}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <span>{branch}</span>
      {team && (
        <span>Changing the lead starts a fresh conversation with a retained work handoff.</span>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
