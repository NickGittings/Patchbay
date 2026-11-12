import { useState } from 'react'
import { useStore } from '../store'
import type { SessionRecord } from '../types'
import { agentDevices } from '../lib/plan'
import { chatAutoActive, chatBusy, chatRecipient } from '../lib/chat'
import { EMPTY_SIMPLE_UI, simpleKey, useSimpleUi } from '../lib/simpleUi'
import { useChatTeams } from '../lib/chatTeams'
import { defaultChatPreset, switchChatAgent } from '../lib/chatAgent'

export default function ChatAgentPicker({ records }: { records: SessionRecord[] }) {
  const s = useStore()
  const projectId = s.project?.id ?? ''
  const task = s.activeTask
  const key = simpleKey(projectId, task)
  const team = useChatTeams((s) => s.teams[projectId]?.find((t) => t.task === task))
  const ui = useSimpleUi((u) => u.worktrees[key] ?? EMPTY_SIMPLE_UI)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const recipient = chatRecipient(records, s.simple?.selectedAgent)
  const preset = defaultChatPreset(
    s.devices,
    s.agentRoles,
    ui.chatPreset ?? s.workspaceSettings.chatAgent,
  )
  const disabled =
    !!ui.pendingAction ||
    !!ui.pendingWorkflow ||
    !!ui.queued ||
    !!team?.reset ||
    chatAutoActive(s.auto?.status) ||
    chatBusy(recipient && s.sessions[recipient.id])
  return (
    <div className="chat-agent-picker">
      <span>Agent: {recipient?.metadata.name ?? preset?.name ?? 'Unavailable'}</span>
      <button disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>
        Switch agent…
      </button>
      {open && (
        <div className="chat-agent-switch">
          <p>Switching starts a fresh agent conversation with retained work context and workers.</p>
          <select
            aria-label="Switch chat agent"
            value=""
            disabled={disabled}
            onChange={async (e) => {
              const id = e.target.value
              if (!id || disabled || !projectId) return
              setError('')
              if (!recipient) {
                useSimpleUi.getState().patch(key, { chatPreset: id })
                setOpen(false)
                return
              }
              useSimpleUi.getState().patch(key, { pendingAction: true })
              try {
                await switchChatAgent(projectId, task, id)
                setOpen(false)
              } catch (e) {
                setError(String(e))
              } finally {
                useSimpleUi.getState().patch(key, { pendingAction: false })
              }
            }}
          >
            <option value="" disabled>
              Choose an agent preset…
            </option>
            {agentDevices(s.devices).map((a) => (
              <option value={a.id} key={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
