import { useState } from 'react'
import { useStore } from '../store'
import { simpleKey, useSimpleUi } from '../lib/simpleUi'
import { refreshChatTeams } from '../lib/chatTeams'
import { openWorktreeAuto, WorkBlocker, workError } from '../lib/workBlocker'

export default function WorkFeedback({
  error,
  onOpenAuto,
  label,
}: {
  error: Error
  onOpenAuto?: () => void
  label?: string
}) {
  const recovery = error instanceof WorkBlocker ? error.recovery : undefined
  const [failure, setFailure] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  // A recovery result belongs to the error it answered; a different error clears it.
  const [shown, setShown] = useState(error.message)
  if (shown !== error.message) {
    setShown(error.message)
    setFailure('')
  }
  return (
    <div className="file-tree-error">
      <p role="alert">
        {label ? `${label} could not complete the command. ` : null}
        {error.message}
      </p>
      {recovery?.kind === 'auto' && (
        <button
          type="button"
          onClick={() => {
            try {
              openWorktreeAuto(recovery.target, recovery.returnAfterStop)
              onOpenAuto?.()
            } catch (e) {
              setFailure(workError(e).message)
            }
          }}
        >
          Open Auto
        </button>
      )}
      {recovery?.kind === 'failedWorker' && (
        <button
          type="button"
          onClick={() => {
            const { projectId, task } = recovery.target
            const current = useStore.getState()
            if (current.project?.id !== projectId || current.activeTask !== task) return
            const retry = document.getElementById(recovery.assignment)
            if (retry) retry.focus()
            else
              useSimpleUi.getState().patch(simpleKey(projectId, task), {
                agents: true,
                changes: false,
              })
          }}
        >
          Open {recovery.name} retry
        </button>
      )}
      {recovery?.kind === 'refreshLead' && (
        <button
          type="button"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true)
            setFailure('')
            try {
              await refreshChatTeams(recovery.projectId)
              setFailure('Lead state refreshed. Try the work command again.')
            } catch (e) {
              setFailure(workError(e).message)
            } finally {
              setRefreshing(false)
            }
          }}
        >
          Refresh lead state
        </button>
      )}
      {failure && <p role="status">{failure}</p>}
    </div>
  )
}
