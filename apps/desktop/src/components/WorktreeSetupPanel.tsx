import { useState } from 'react'
import { useStore } from '../store'
import { saveMapNow } from '../lib/mapSave'
import { enableWorktreeSetup } from '../lib/ipc'
import Dialog from './Dialog'

export default function WorktreeSetupPanel({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project)
  const [command, setCommand] = useState(project?.worktreeSetup?.command ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog title="Worktree setup" onClose={onClose}>
      <p>
        Run once at each new worktree’s root, before implementation. Scripts can use
        PATCHBAY_PROJECT_ROOT and PATCHBAY_WORKTREE_ROOT.
      </p>
      <label>
        Command
        <input value={command} onChange={(e) => setCommand(e.target.value)} />
      </label>
      <p>
        Saving records this command in patchbay.json. Enable this exact command locally to allow
        automatic execution. A changed command needs new enablement.
      </p>
      <pre>{command || 'No setup configured'}</pre>
      {error && <p role="alert">{error}</p>}
      <button
        disabled={busy}
        onClick={() => {
          if (!project) return
          setBusy(true)
          useStore.setState({
            project: { ...project, worktreeSetup: command.trim() ? { command } : undefined },
            dirty: true,
          })
          void saveMapNow(project.id)
            .then((saved) => {
              if (saved) onClose()
              else setError('The project could not be saved. Check its map saving status.')
            })
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false))
        }}
      >
        Save
      </button>
      <button
        disabled={busy || !command.trim() || !project}
        onClick={() => {
          if (!project) return
          setBusy(true)
          void enableWorktreeSetup(project.id, command)
            .then(() => setError('Enabled locally for this exact command.'))
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false))
        }}
      >
        Enable exact command locally
      </button>
    </Dialog>
  )
}
