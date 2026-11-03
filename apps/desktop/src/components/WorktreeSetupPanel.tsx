import { useState } from 'react'
import { useStore } from '../store'
import { saveMapNow } from '../lib/mapSave'
import { enableWorktreeSetup } from '../lib/ipc'
import { mapEditsBlocked } from '../lib/mapSave'

export default function WorktreeSetupPanel() {
  const project = useStore((s) => s.project)
  const [draft, setDraft] = useState<string | null>(null)
  const command = draft ?? project?.worktreeSetup?.command ?? ''
  const blocked = useStore((s) => !!s.project && mapEditsBlocked(s.projects[s.project.id]))
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <section className="panel-section" aria-label="Worktree preparation">
      <strong>Worktree preparation</strong>
      <p>
        Run once at each new worktree’s root, before implementation. Saving applies to new tasks;
        existing tasks keep their captured setup. Scripts can use PATCHBAY_PROJECT_ROOT and
        PATCHBAY_WORKTREE_ROOT.
      </p>
      <label>
        Command
        <input value={command} onChange={(e) => setDraft(e.target.value)} />
      </label>
      <p>
        Saving records this command in patchbay.json. Enable this exact command locally to allow
        automatic execution. A changed command needs new enablement.
      </p>
      <pre>{command || 'No setup configured'}</pre>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button
        disabled={busy || blocked}
        onClick={() => {
          if (!project) return
          setError('')
          setMessage('')
          setBusy(true)
          useStore.setState({
            project: { ...project, worktreeSetup: command.trim() ? { command } : undefined },
            dirty: true,
          })
          void saveMapNow(project.id)
            .then((saved) => {
              if (saved) {
                setDraft(null)
                setMessage('Preparation saved for new tasks.')
              } else setError('The project could not be saved. Check its map saving status.')
            })
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false))
        }}
      >
        Save
      </button>
      <button
        disabled={busy || blocked || !command.trim() || !project}
        onClick={() => {
          if (!project) return
          setError('')
          setMessage('')
          setBusy(true)
          void enableWorktreeSetup(project.id, command)
            .then(() => setMessage('Enabled locally for this exact command.'))
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false))
        }}
      >
        Enable exact command locally
      </button>
    </section>
  )
}
