import { useState } from 'react'
import { useStore } from '../store'
import type { SessionRecord } from '../types'
import { agentDevices } from '../lib/plan'
import { chatAutoActive, chatBusy, chatRecipient } from '../lib/chat'
import { EMPTY_SIMPLE_UI, simpleKey, useSimpleUi } from '../lib/simpleUi'
import { useChatTeams } from '../lib/chatTeams'
import { changeChatAgent, defaultChatPreset } from '../lib/chatAgent'
import { autoOf, simpleOf } from '../lib/chatHome'

export default function ChatAgentPicker({
  records,
  task,
}: {
  records: SessionRecord[]
  /** The worktree whose conversation this is: Chat's lead lives in the project folder. */
  task: string | null
}) {
  const s = useStore()
  const projectId = s.project?.id ?? ''
  const key = simpleKey(projectId, task)
  const team = useChatTeams((s) => s.teams[projectId]?.find((t) => t.task === task))
  const ui = useSimpleUi((u) => u.worktrees[key] ?? EMPTY_SIMPLE_UI)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState('')
  const [error, setError] = useState('')
  const recipient = chatRecipient(records, simpleOf(s, task)?.selectedAgent)
  const preset = defaultChatPreset(
    s.devices,
    s.agentRoles,
    ui.chatPreset ?? s.workspaceSettings.chatAgent,
  )
  const presets = agentDevices(s.devices)
  // A team can replace its lead at any time; only an unmanaged agent has to finish first.
  const leadBusy = chatBusy(s.sessions[team?.lead.sessionId ?? recipient?.id ?? ''])
  const disabled =
    !!ui.pendingAction ||
    !!ui.pendingWorkflow ||
    !!team?.reset ||
    chatAutoActive(autoOf(s, task)?.status) ||
    (!team && (!!ui.queued || leadBusy))
  const change = async (id: string) => {
    setConfirming('')
    if (!id || disabled || !projectId) return
    setError('')
    if (!recipient && !team) {
      useSimpleUi.getState().patch(key, { chatPreset: id })
      setOpen(false)
      return
    }
    try {
      await changeChatAgent(projectId, task, id)
      setOpen(false)
    } catch (e) {
      setError(String(e))
    }
  }
  const pending = presets.find((a) => a.id === confirming)
  return (
    <div className="chat-agent-picker">
      <span>Agent: {recipient?.metadata.name ?? preset?.name ?? 'Unavailable'}</span>
      <button disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>
        Switch agent…
      </button>
      {open && (
        <div className="chat-agent-switch">
          <p>
            Switching starts a fresh agent conversation with retained work context and sub-builders.
          </p>
          <select
            aria-label="Switch chat agent"
            value=""
            disabled={disabled}
            onChange={(e) => {
              if (team && leadBusy) setConfirming(e.target.value)
              else void change(e.target.value)
            }}
          >
            <option value="" disabled>
              Choose an agent preset…
            </option>
            {presets.map((a) => (
              <option value={a.id} key={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          {pending && (
            <div role="group" aria-label="Confirm agent switch">
              <p>
                This stops the lead’s current turn and drops any question it is waiting on. Files it
                already wrote stay in the worktree.
              </p>
              <button disabled={disabled} onClick={() => void change(pending.id)}>
                Stop and switch to {pending.name}
              </button>
              <button onClick={() => setConfirming('')}>Cancel</button>
            </div>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
