import { useState } from 'react'
import { useStore } from '../store'
import { saveMapNow } from '../lib/mapSave'
import { enableWorktreeSetup } from '../lib/ipc'
import SettingsDialog, { SettingsFeedback } from './SettingsDialog'

export default function WorktreeSetupPanel({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project)
  const [command, setCommand] = useState(project?.worktreeSetup?.command ?? '')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <SettingsDialog
      title="Worktree setup"
      subtitle="Setup command for this project"
      behavior="Changes apply when you save. Local command enablement is a separate action."
      onClose={onClose}
      footer={
        <>
          <button
            disabled={busy || !command.trim() || !project}
            onClick={() => {
              if (!project) return
              setBusy(true)
              setError('')
              setSuccess('')
              void enableWorktreeSetup(project.id, command)
                .then(() => setSuccess('Enabled locally for this exact command.'))
                .catch((e) => setError(String(e)))
                .finally(() => setBusy(false))
            }}
          >
            Enable exact command locally
          </button>
          <button
            className="primary"
            disabled={busy || !project}
            onClick={() => {
              if (!project) return
              setBusy(true)
              setError('')
              setSuccess('')
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
        </>
      }
    >
      <p>
        Run once at each new worktree’s root, before implementation. Scripts can use
        PATCHBAY_PROJECT_ROOT and PATCHBAY_WORKTREE_ROOT.
      </p>
      <label className="settings-field">
        Command
        <input
          value={command}
          onChange={(e) => {
            setCommand(e.target.value)
            setSuccess('')
          }}
        />
      </label>
      <p>
        Saving records this command in patchbay.json. Enable this exact command locally to allow
        automatic execution. A changed command needs new enablement.
      </p>
      <pre>{command || 'No setup configured'}</pre>
      {error && <SettingsFeedback error>{error}</SettingsFeedback>}
      {success && <SettingsFeedback>{success}</SettingsFeedback>}
    </SettingsDialog>
  )
}
