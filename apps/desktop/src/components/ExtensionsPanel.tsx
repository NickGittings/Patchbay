import SettingsDialog, { SettingsFeedback, SettingsSection } from './SettingsDialog'
import { useStore } from '../store'
import {
  installExtension,
  reloadExtensions,
  revealExtensionsDir,
  setExtensionEnabled,
} from '../lib/ipc'
import { refreshExtensions } from '../extensions/host'
import { useState } from 'react'

export default function ExtensionsPanel() {
  const open = useStore((s) => s.extensionsPanelOpen)
  const registry = useStore((s) => s.extensions)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const perform = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  if (!open) return null
  return (
    <SettingsDialog
      title="Extensions"
      subtitle="Local extensions across projects"
      behavior="Enablement changes apply immediately. Installation and reload run when selected."
      onClose={() => useStore.getState().setExtensionsPanelOpen(false)}
      footer={
        <>
          <button
            disabled={busy}
            onClick={() => void perform(async () => refreshExtensions(await reloadExtensions()))}
          >
            Reload
          </button>

          <button disabled={busy} onClick={() => void perform(revealExtensionsDir)}>
            Open extensions folder
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const registry = await installExtension()
                if (registry) await refreshExtensions(registry)
              })
            }
          >
            Install from folder…
          </button>
        </>
      }
    >
      {error && <SettingsFeedback error>{error}</SettingsFeedback>}
      {busy && <SettingsFeedback>Updating extensions…</SettingsFeedback>}
      <SettingsSection title="Installed extensions">
        {registry.errors.map((message) => (
          <SettingsFeedback error key={message}>
            {message}
          </SettingsFeedback>
        ))}
        {!registry.extensions.length && <p>No local extensions installed.</p>}
        {registry.extensions.map((extension, i) => (
          <div className="extension-entry" key={`${extension.dir}-${i}`}>
            <div className="row">
              <strong title={`${extension.id} · ${extension.dir}`}>
                {extension.manifest.displayName || extension.id}
              </strong>
              <span>{extension.manifest.version}</span>
              <span className="spacer" />
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  aria-label={`Enable ${extension.id}`}
                  checked={extension.enabled}
                  disabled={busy || !!extension.errors.length}
                  onChange={(e) =>
                    void perform(async () =>
                      refreshExtensions(await setExtensionEnabled(extension.id, e.target.checked)),
                    )
                  }
                />
                Enabled
              </label>
            </div>
            <div>{extension.id}</div>
            <small title={extension.dir}>Local folder: {extension.dir}</small>
            {extension.errors.map((message) => (
              <SettingsFeedback error key={message}>
                {message}
              </SettingsFeedback>
            ))}
          </div>
        ))}
      </SettingsSection>
    </SettingsDialog>
  )
}
