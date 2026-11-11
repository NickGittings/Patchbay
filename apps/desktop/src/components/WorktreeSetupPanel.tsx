import { useState } from 'react'
import { useStore } from '../store'
import { saveMapNow } from '../lib/mapSave'
import { enableWorktreeSetup } from '../lib/ipc'
import { mapEditsBlocked } from '../lib/mapSave'
import { SettingsFeedback } from './SettingsDialog'

export default function WorktreeSetupPanel() {
  const project = useStore((s) => s.project)
  const [draft, setDraft] = useState<string | null>(null)
  const command = draft ?? project?.worktreeSetup?.command ?? ''
  const blocked = useStore((s) => !!s.project && mapEditsBlocked(s.projects[s.project.id]))
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <section className="worktree-setup-editor" aria-label="Worktree preparation">
      <p className="hint">
        Runs at the worktree root before implementation. Changes apply to new tasks.
      </p>
      <label className="settings-field">
        Command
        <textarea
          rows={3}
          placeholder="No preparation configured"
          value={command}
          onChange={(e) => {
            setDraft(e.target.value)
            setMessage('')
          }}
        />
      </label>
      <p className="hint">Scripts can use PATCHBAY_PROJECT_ROOT and PATCHBAY_WORKTREE_ROOT.</p>
      <p className="hint">
        Save to patchbay.json, then enable locally to run automatically. Each changed command needs
        enablement.
      </p>
      <div className="row">
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
      </div>
      {error && <SettingsFeedback error>{error}</SettingsFeedback>}
      {message && <SettingsFeedback>{message}</SettingsFeedback>}
    </section>
  )
}
