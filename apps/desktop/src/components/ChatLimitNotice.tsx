import { useState } from 'react'
import { useStore } from '../store'
import type { SessionRecord } from '../types'
import { agentDevices } from '../lib/plan'
import { chatAutoActive, chatRecipient, limitStopped } from '../lib/chat'
import { changeChatAgent } from '../lib/chatAgent'
import { useChatTeams } from '../lib/chatTeams'
import { autoOf, simpleOf } from '../lib/chatHome'
import { useClockNow } from '../lib/clock'
import { EMPTY_SIMPLE_UI, simpleKey, useSimpleUi } from '../lib/simpleUi'
import {
  exhaustedWindows,
  presetExhausted,
  providerName,
  resetLabel,
  resetsIn,
  useUsage,
} from '../lib/usage'

/** A recipient stopped by its usage limit, with one click to continue on another agent. */
export default function ChatLimitNotice({
  records,
  task,
}: {
  records: SessionRecord[]
  /** The conversation's worktree: Chat's lead lives in the project folder. */
  task: string | null
}) {
  const s = useStore()
  const projectId = s.project?.id ?? ''
  const team = useChatTeams((t) => t.teams[projectId]?.find((team) => team.task === task))
  const ui = useSimpleUi((u) => u.worktrees[simpleKey(projectId, task)] ?? EMPTY_SIMPLE_UI)
  const usage = useUsage((u) => u.usage)
  const [error, setError] = useState('')
  const recipient = chatRecipient(records, simpleOf(s, task)?.selectedAgent)
  const session = recipient && s.sessions[recipient.id]
  const provider = session?.status?.agent?.provider
  const presets = agentDevices(s.devices)
  const now = useClockNow(
    [
      ...exhaustedWindows(usage, provider, 0),
      ...presets.flatMap((preset) => presetExhausted(usage, preset, 0)),
    ].map((w) => w.window.resetsAtMs),
  )
  if (!recipient || !limitStopped(session)) return null
  const name = provider ? providerName(provider) : recipient.metadata.name
  const resetsAt = Math.max(
    0,
    ...exhaustedWindows(usage, provider, now).map((w) => w.window.resetsAtMs),
  )
  const isLead = team?.lead.sessionId === recipient.id
  const disabled =
    !!ui.pendingAction ||
    !!ui.pendingWorkflow ||
    !!team?.reset ||
    chatAutoActive(autoOf(s, task)?.status)
  const command = recipient.metadata.command || recipient.spec.command
  return (
    <div className="chat-limit-notice" role="status">
      <p>
        {name} stopped at its usage limit.{' '}
        {resetsAt
          ? `Resets ${resetLabel(resetsAt, now)} · in ${resetsIn(resetsAt, now)}.`
          : 'Send again once it resets.'}
      </p>
      {isLead && (
        <div>
          {presets
            .filter((preset) => preset.command !== command)
            .map((preset) => {
              const blocked = presetExhausted(usage, preset, now).length > 0
              return (
                <button
                  key={preset.id}
                  disabled={disabled || blocked}
                  title={blocked ? `${preset.name} is also at its usage limit` : undefined}
                  onClick={() => {
                    setError('')
                    changeChatAgent(projectId, task, preset.id).catch((e) => setError(String(e)))
                  }}
                >
                  Continue with {preset.name}
                </button>
              )
            })}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
